import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HookInstallStatus } from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('codex-hook-installer');

const HOOK_TAG = 'agent-deck-hook';

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostCompact',
  'Stop',
] as const;

type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

type HookEventValue = unknown;

interface CodexHooksJson {
  hooks?: Partial<Record<CodexHookEvent, HookEventValue>>;
  [key: string]: unknown;
}

function hooksPath(scope: 'user' | 'project', cwd?: string): string {
  if (scope === 'user') return join(homedir(), '.codex', 'hooks.json');
  if (!cwd) throw new Error('project scope requires cwd');
  return join(cwd, '.codex', 'hooks.json');
}

function routeName(event: CodexHookEvent): string {
  return event.toLowerCase();
}

function buildCommand(port: number, token: string, event: CodexHookEvent): string {
  return `cat | curl -sS -m 2 -X POST http://127.0.0.1:${port}/hook/codex/${routeName(event)} -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' -H "X-Agent-Deck-Origin: \${AGENT_DECK_ORIGIN:-cli}" -H "X-Agent-Deck-Parent-Pid: \${PPID:-}" --data-binary @- > /dev/null || true # ${HOOK_TAG}`;
}

function readHooksJson(path: string): CodexHooksJson {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CodexHooksJson;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${path} parse failed (${detail}). Aborted to avoid overwriting existing Codex hook config.`,
    );
  }
}

function hooksObject(data: CodexHooksJson): Partial<Record<CodexHookEvent, HookEventValue>> {
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    data.hooks = {};
  }
  return data.hooks;
}

function writeHooksJson(path: string, data: CodexHooksJson): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function isOurHookEntry(entry: HookEntry): boolean {
  return typeof entry.command === 'string' && entry.command.includes(HOOK_TAG);
}

function coerceHookEntry(entry: unknown): HookEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return entry as HookEntry;
}

function coerceHookGroups(value: HookEventValue): HookGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((group): group is Record<string, unknown> => (
      !!group && typeof group === 'object' && !Array.isArray(group)
    ))
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks)
        ? group.hooks.map(coerceHookEntry).filter((hook): hook is HookEntry => hook !== null)
        : [],
    }));
}

function cleanedGroups(groups: HookEventValue): HookGroup[] {
  return coerceHookGroups(groups)
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((hook) => !isOurHookEntry(hook)),
    }))
    .filter((group) => group.hooks.length > 0);
}

function matcherFor(event: CodexHookEvent): string | undefined {
  if (event === 'Stop') return undefined;
  return '.*';
}

export class CodexHookInstaller {
  constructor(
    private port: number,
    private token: string,
  ) {}

  install(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = hooksPath(opts.scope, opts.cwd);
    const data = readHooksJson(path);
    const hooks = hooksObject(data);
    const installed: string[] = [];

    for (const event of CODEX_HOOK_EVENTS) {
      const groups = hooks[event] ?? [];
      const next = cleanedGroups(groups);
      const matcher = matcherFor(event);
      next.push({
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: 'command',
            command: buildCommand(this.port, this.token, event),
            timeout: 5,
            statusMessage: 'Reporting to Agent Deck',
          },
        ],
      });
      hooks[event] = next;
      installed.push(event);
    }

    writeHooksJson(path, data);
    return {
      installed: true,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: installed,
    };
  }

  uninstall(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = hooksPath(opts.scope, opts.cwd);
    if (!existsSync(path)) {
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }

    const data = readHooksJson(path);
    if (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)) {
      const hooks = data.hooks;
      for (const event of CODEX_HOOK_EVENTS) {
        const groups = hooks[event];
        if (!groups) continue;
        const next = cleanedGroups(groups);
        if (next.length === 0) delete hooks[event];
        else hooks[event] = next;
      }
      if (Object.keys(hooks).length === 0) delete data.hooks;
    }

    writeHooksJson(path, data);
    return {
      installed: false,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: [],
    };
  }

  status(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = hooksPath(opts.scope, opts.cwd);
    if (!existsSync(path)) {
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }

    let data: CodexHooksJson;
    try {
      data = readHooksJson(path);
    } catch (err) {
      logger.warn('[codex-hook-installer] status readHooksJson failed:', err);
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }

    const installed: string[] = [];
    for (const event of CODEX_HOOK_EVENTS) {
      const groups = coerceHookGroups(
        data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)
          ? data.hooks[event]
          : [],
      );
      for (const group of groups) {
        if (group.hooks.some(isOurHookEntry)) {
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
