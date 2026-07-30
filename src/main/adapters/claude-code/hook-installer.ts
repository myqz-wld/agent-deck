import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { HookInstallStatus } from '@shared/types';
import log from '@main/utils/logger';
import { buildHookCurlCommand } from '@main/hook-server/curl-command';

const logger = log.scope('claude-hook-installer');

/**
 * 在 ~/.claude/settings.json 或 <cwd>/.claude/settings.json 中
 * 注入/卸载本应用使用的 Claude Code hook。
 *
 * 每条 hook 命令带特殊标记 `# agent-deck-hook` 用于识别本应用注入的条目。
 */

const HOOK_TAG = 'agent-deck-hook';
const CURRENT_HOOK_TAG = 'agent-deck-hook-grok-guard';

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'MessageDisplay',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

// Universal team backend owns these lifecycles. Older Agent Deck versions installed the hooks,
// so keep them in cleanup even though they must no longer be active (their routes were removed).
const LEGACY_HOOK_EVENTS = [
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
] as const;

type HookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
type OwnedHookEvent = HookEvent | (typeof LEGACY_HOOK_EVENTS)[number];

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
  hooks?: Partial<Record<OwnedHookEvent, HookEventValue>>;
  [key: string]: unknown;
}

function buildCommand(port: number, token: string, event: HookEvent): string {
  // X-Agent-Deck-Origin header 转发 AGENT_DECK_ORIGIN env：
  // - SDK spawn 的 CLI 子进程继承应用注入的 env=sdk → header 'sdk'
  // - 用户独立终端跑 `claude` 无此 env → ${...:-cli} 兜底为 'cli'
  // header 用**双引号**外层让 shell 展开 ${AGENT_DECK_ORIGIN:-cli}；其它 header 仍单引号
  // （token / Content-Type 是写入时已替换的字面量，不需要 shell 展开）。
  // Grok Build discovers Claude Code-compatible hooks by default and exposes GROK_HOOK_EVENT to hook
  // commands. Consume but do not forward that compatibility invocation: the native Grok Build hook
  // owns external Grok Build reporting, while genuine Claude Code processes do not set this variable.
  return buildHookCurlCommand({
    port,
    token,
    route: `/hook/${event.toLowerCase()}`,
    tag: CURRENT_HOOK_TAG,
    compatibilityGuardEnvironment: 'GROK_HOOK_EVENT',
  });
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
 * parse 失败必须直接抛错，避免 install 把损坏文件当成空配置并覆盖用户已有的
 * permissions / mcpServers / env 等非 hooks 配置。状态查询路径在外层 try/catch
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
 * 进程崩溃 / 断电 / 磁盘满都会留半个 JSON 文件，下次 Claude Code `JSON.parse` 失败配置全丢。
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

function isCurrentHookEntry(entry: HookEntry): boolean {
  return entry.type === 'command' && entry.command.includes(CURRENT_HOOK_TAG);
}

function cleanedGroups(groups: HookEventValue): HookGroup[] {
  return groups
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((hook) => !isOurHookEntry(hook)),
    }))
    .filter((group) => group.hooks.length > 0);
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

    // Remove obsolete team hooks left by older Agent Deck releases. They intentionally have no
    // route now, so leaving them installed would make every matching Claude Code event hit a 404.
    for (const event of LEGACY_HOOK_EVENTS) {
      const groups = data.hooks[event];
      if (!groups) continue;
      const cleaned = cleanedGroups(groups);
      if (cleaned.length === 0) delete data.hooks[event];
      else data.hooks[event] = cleaned;
    }

    for (const event of CLAUDE_HOOK_EVENTS) {
      const cmd = buildCommand(this.port, this.token, event);
      const groups = (data.hooks[event] ?? []) as HookEventValue;

      // 移除本应用旧 hook（避免端口 / token 变化或重复注入）
      const cleaned = cleanedGroups(groups);

      // 加入新 hook
      const matcher = [
        'PreToolUse',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PermissionDenied',
      ].includes(event)
        ? '*'
        : undefined;
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
      for (const event of [...CLAUDE_HOOK_EVENTS, ...LEGACY_HOOK_EVENTS]) {
        const groups = data.hooks[event];
        if (!groups) continue;
        const cleaned = cleanedGroups(groups);
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
      logger.warn('[hook-installer] status readSettings failed:', err);
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }
    const installed: string[] = [];
    for (const event of CLAUDE_HOOK_EVENTS) {
      const groups = data.hooks?.[event] ?? [];
      for (const g of groups) {
        if (g.hooks.some(isCurrentHookEntry)) {
          installed.push(event);
          break;
        }
      }
    }
    const hasLegacyOwnedHook = LEGACY_HOOK_EVENTS.some((event) =>
      (data.hooks?.[event] ?? []).some((group) => group.hooks.some(isOurHookEntry)),
    );
    return {
      installed:
        installed.length === CLAUDE_HOOK_EVENTS.length && !hasLegacyOwnedHook,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: installed,
    };
  }
}
