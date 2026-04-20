import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

function buildCommand(port: number, event: HookEvent): string {
  // 用 cat 把 stdin JSON 转发给 curl；末尾 || true 防止 curl 失败影响 Claude Code
  // 标记 `# agent-deck-hook` 用于识别本应用注入的条目
  return `cat | curl -sS -m 2 -X POST http://127.0.0.1:${port}/hook/${event.toLowerCase()} -H 'Content-Type: application/json' --data-binary @- > /dev/null || true # ${HOOK_TAG}`;
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

function readSettings(p: string): ClaudeSettings {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ClaudeSettings;
  } catch (err) {
    console.warn(`[hook-installer] failed to parse ${p}:`, err);
    return {};
  }
}

function writeSettings(p: string, data: ClaudeSettings): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isOurHookEntry(entry: HookEntry): boolean {
  return entry.type === 'command' && entry.command.includes(HOOK_TAG);
}

export class HookInstaller {
  constructor(private port: number) {}

  install(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = settingsPath(opts.scope, opts.cwd);
    const data = readSettings(path);
    data.hooks = data.hooks ?? {};
    const installed: string[] = [];

    for (const event of HOOK_EVENTS) {
      const cmd = buildCommand(this.port, event);
      const groups = (data.hooks[event] ?? []) as HookEventValue;

      // 移除本应用旧 hook（避免端口变化或重复注入）
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
    const data = readSettings(path);
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
