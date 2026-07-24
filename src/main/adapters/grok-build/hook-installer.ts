import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HookInstallStatus } from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('grok-hook-installer');
const HOOK_TAG = 'agent-deck-grok-hook';

export const GROK_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'PostCompact',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

type GrokHookEvent = (typeof GROK_HOOK_EVENTS)[number];

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

interface GrokHooksJson {
  hooks?: Partial<Record<GrokHookEvent, unknown>>;
  [key: string]: unknown;
}

function hooksPath(scope: 'user' | 'project', cwd?: string): string {
  if (scope === 'user') return join(homedir(), '.grok', 'hooks', 'agent-deck.json');
  if (!cwd) throw new Error('project scope requires cwd');
  return join(cwd, '.grok', 'hooks', 'agent-deck.json');
}

function buildCommand(port: number, token: string, event: GrokHookEvent): string {
  return `cat | curl -sS -m 2 -X POST http://127.0.0.1:${port}/hook/grok/${event.toLowerCase()} -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' -H "X-Agent-Deck-Origin: \${AGENT_DECK_ORIGIN:-cli}" -H "X-Agent-Deck-Parent-Pid: \${PPID:-}" --data-binary @- > /dev/null || true # ${HOOK_TAG}`;
}

function readHooksJson(path: string): GrokHooksJson {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GrokHooksJson;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${path} parse failed (${detail}). Aborted to avoid overwriting existing Grok hook config.`,
    );
  }
}

function hooksObject(data: GrokHooksJson): Partial<Record<GrokHookEvent, unknown>> {
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    data.hooks = {};
  }
  return data.hooks;
}

function writeHooksJson(path: string, data: GrokHooksJson): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
}

function isOurHookEntry(entry: HookEntry): boolean {
  return typeof entry.command === 'string' && entry.command.includes(HOOK_TAG);
}

function coerceHookEntry(value: unknown): HookEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as HookEntry;
}

function coerceHookGroups(value: unknown): HookGroup[] {
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

function cleanedGroups(value: unknown): HookGroup[] {
  return coerceHookGroups(value)
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((hook) => !isOurHookEntry(hook)),
    }))
    .filter((group) => group.hooks.length > 0);
}

function hasOwnContent(data: GrokHooksJson): boolean {
  return Object.keys(data).length > 0;
}

export class GrokHookInstaller {
  constructor(
    private port: number,
    private token: string,
  ) {}

  install(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = hooksPath(opts.scope, opts.cwd);
    const data = readHooksJson(path);
    const hooks = hooksObject(data);

    for (const event of GROK_HOOK_EVENTS) {
      const groups = cleanedGroups(hooks[event]);
      groups.push({
        hooks: [
          {
            type: 'command',
            command: buildCommand(this.port, this.token, event),
            timeout: 5,
          },
        ],
      });
      hooks[event] = groups;
    }

    writeHooksJson(path, data);
    return {
      installed: true,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: [...GROK_HOOK_EVENTS],
    };
  }

  uninstall(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = hooksPath(opts.scope, opts.cwd);
    if (!existsSync(path)) return this.emptyStatus(opts.scope, path);

    const data = readHooksJson(path);
    if (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)) {
      for (const event of GROK_HOOK_EVENTS) {
        const groups = cleanedGroups(data.hooks[event]);
        if (groups.length === 0) delete data.hooks[event];
        else data.hooks[event] = groups;
      }
      if (Object.keys(data.hooks).length === 0) delete data.hooks;
    }

    if (hasOwnContent(data)) writeHooksJson(path, data);
    else unlinkSync(path);
    return this.emptyStatus(opts.scope, path);
  }

  status(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = hooksPath(opts.scope, opts.cwd);
    if (!existsSync(path)) return this.emptyStatus(opts.scope, path);

    let data: GrokHooksJson;
    try {
      data = readHooksJson(path);
    } catch (error) {
      logger.warn('[grok-hook-installer] status readHooksJson failed:', error);
      return this.emptyStatus(opts.scope, path);
    }

    const installed: string[] = [];
    const hooks =
      data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)
        ? data.hooks
        : {};
    for (const event of GROK_HOOK_EVENTS) {
      if (coerceHookGroups(hooks[event]).some((group) => group.hooks.some(isOurHookEntry))) {
        installed.push(event);
      }
    }
    return {
      installed: installed.length > 0,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: installed,
    };
  }

  private emptyStatus(
    scope: 'user' | 'project',
    settingsPath: string,
  ): HookInstallStatus {
    return {
      installed: false,
      scope,
      settingsPath,
      installedHooks: [],
    };
  }
}
