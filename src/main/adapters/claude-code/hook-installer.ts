import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { HookInstallStatus } from '@shared/types';

/**
 * 在 ~/.claude/settings.json 或 <cwd>/.claude/settings.json 中
 * 注入/卸载本应用使用的 5 条 hook。
 *
 * 每条 hook 命令带特殊标记 `# agent-deck-hook` 用于识别本应用注入的条目。
 */

export const HOOK_TAG = 'agent-deck-hook';

const HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookEntry {
  type: 'command';
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

type HookEventValue = HookGroup[];

interface ClaudeSettings {
  hooks?: Partial<Record<HookEvent, HookEventValue>>;
  [key: string]: unknown;
}

function buildCommand(port: number, token: string, event: HookEvent): string {
  // 用 cat 把 stdin JSON 转发给 curl；末尾 || true 防止 curl 失败影响 Claude Code。
  // 标记 `# agent-deck-hook` 用于识别本应用注入的条目。
  // Authorization 头：本机 127.0.0.1 监听虽然外部访问不到，但同机其它进程能直接
  // curl 伪造 AgentEvent 污染 SQLite，靠 server 端 onRequest 校验 Bearer token 拦住。
  // 注意：shell 转义用单引号外层不冲突——token 是 hex（[0-9a-f]）不含单引号 / 反斜杠。
  return `cat | curl -sS -m 2 -X POST http://127.0.0.1:${port}/hook/${event.toLowerCase()} -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' --data-binary @- > /dev/null || true # ${HOOK_TAG}`;
}

function settingsPath(scope: 'user' | 'project', cwd?: string): string {
  if (scope === 'user') {
    return join(homedir(), '.claude', 'settings.json');
  }
  if (!cwd) {
    throw new Error('project scope requires cwd');
  }
  return join(cwd, '.claude', 'settings.json');
}

/**
 * 读 settings.json。文件不存在 → 返回空对象（首次安装路径）。
 * REVIEW_2 修：原本 parse 失败也回退 {} 然后 install 再 writeSettings 把整个文件覆盖，
 * 用户的 permissions / mcpServers / env 等所有非 hooks 配置都被抹掉。
 * 现在 parse 失败直接抛错让上层（IPC handler / UI）感知；状态查询路径在外层 try/catch
 * 单独兜底为「未安装 + 错误信息」，install/uninstall 让用户看到错误而不是默默丢配置。
 */
function readSettings(p: string): ClaudeSettings {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ClaudeSettings;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${p} 解析失败（${detail}）。为避免覆盖用户原配置，已中止操作；请人工修复 JSON 后重试。`,
    );
  }
}

/**
 * 原子写：write tmp + rename。
 * `~/.claude/settings.json` 通常不只装 hook，还有 permissions / mcpServers / env 等
 * 用户多年积累的配置；直接 writeFileSync 是 open(O_TRUNC)+write 两步，
 * 进程崩溃 / 断电 / 磁盘满都会留半个 JSON 文件，下次 Claude `JSON.parse` 失败配置全丢。
 * POSIX rename 是原子的（同文件系统内），即使中途崩溃磁盘上看到的不是旧版就是新版，
 * 不会出现"半截 JSON"。
 */
function writeSettings(p: string, data: ClaudeSettings): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}

function isOurHookEntry(entry: HookEntry): boolean {
  return entry.type === 'command' && entry.command.includes(HOOK_TAG);
}

export class HookInstaller {
  constructor(
    private port: number,
    private token: string,
  ) {}

  install(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = settingsPath(opts.scope, opts.cwd);
    const data = readSettings(path);
    data.hooks = data.hooks ?? {};
    const installed: string[] = [];

    for (const event of HOOK_EVENTS) {
      const cmd = buildCommand(this.port, this.token, event);
      const groups = (data.hooks[event] ?? []) as HookEventValue;

      // 移除本应用旧 hook（避免端口 / token 变化或重复注入）
      const cleaned: HookGroup[] = groups
        .map((g) => ({
          ...g,
          hooks: g.hooks.filter((h) => !isOurHookEntry(h)),
        }))
        .filter((g) => g.hooks.length > 0);

      // 加入新 hook
      const matcher = event === 'PreToolUse' || event === 'PostToolUse' ? '*' : undefined;
      cleaned.push({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command: cmd }],
      });
      data.hooks[event] = cleaned;
      installed.push(event);
    }

    writeSettings(path, data);
    return {
      installed: true,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: installed,
    };
  }

  uninstall(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = settingsPath(opts.scope, opts.cwd);
    if (!existsSync(path)) {
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }
    const data = readSettings(path);
    if (data.hooks) {
      for (const event of HOOK_EVENTS) {
        const groups = data.hooks[event];
        if (!groups) continue;
        const cleaned = groups
          .map((g) => ({
            ...g,
            hooks: g.hooks.filter((h) => !isOurHookEntry(h)),
          }))
          .filter((g) => g.hooks.length > 0);
        if (cleaned.length === 0) {
          delete data.hooks[event];
        } else {
          data.hooks[event] = cleaned;
        }
      }
      // 若 hooks 整体为空，删掉键
      if (Object.keys(data.hooks).length === 0) {
        delete data.hooks;
      }
    }
    writeSettings(path, data);
    return {
      installed: false,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: [],
    };
  }

  status(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = settingsPath(opts.scope, opts.cwd);
    if (!existsSync(path)) {
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }
    // status 是只读查询：readSettings parse 失败时不抛（否则 UI 卡死无法显示设置面板），
    // 退化为「未安装 + console.warn」。install/uninstall 路径仍会抛错让用户知情。
    let data: ClaudeSettings;
    try {
      data = readSettings(path);
    } catch (err) {
      console.warn('[hook-installer] status readSettings failed:', err);
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }
    const installed: string[] = [];
    for (const event of HOOK_EVENTS) {
      const groups = data.hooks?.[event] ?? [];
      for (const g of groups) {
        if (g.hooks.some(isOurHookEntry)) {
          installed.push(event);
          break;
        }
      }
    }
    return {
      installed: installed.length > 0,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: installed,
    };
  }
}
