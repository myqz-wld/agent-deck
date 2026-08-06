import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookInstallStatus } from '@shared/types';
import { buildHookCurlCommand } from '@main/hook-server/curl-command';
import {
  changedHookEvent,
  hooksObject,
  readHookConfig,
  strictHookGroups,
  updateHookConfig,
  withoutOwnedHookCommands,
  type HookConfigChange,
  type HookConfigDocument,
  type HookGroup,
  type JsonObject,
} from '@main/hook-server/hook-config-file';
import {
  hookRelayConfigPath,
  prepareHookRelayConfig,
} from '@main/hook-server/hook-relay-config';

const CURRENT_HOOK_TAG_PREFIX = 'agent-deck-hook-v2-codex-cli';

export interface CodexHookInstallerObserver {
  statusReadFailed(error: unknown): void;
}

const NOOP_OBSERVER: CodexHookInstallerObserver = {
  statusReadFailed: () => undefined,
};

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const;

type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

function hooksPath(scope: 'user' | 'project', cwd?: string): string {
  if (scope === 'user') return join(homedir(), '.codex', 'hooks.json');
  if (!cwd) throw new Error('project scope requires cwd');
  return join(cwd, '.codex', 'hooks.json');
}

function routeFor(event: CodexHookEvent): string {
  return `/hook/codex/${event.toLowerCase()}`;
}

function currentTag(event: CodexHookEvent): string {
  return `${CURRENT_HOOK_TAG_PREFIX}-${event.toLowerCase()}`;
}

function matcherFor(event: CodexHookEvent): string | undefined {
  return event === 'PreToolUse' ||
    event === 'PermissionRequest' ||
    event === 'PostToolUse'
    ? '.*'
    : undefined;
}

function updateModes(scope: 'user' | 'project'): {
  modeForNew: number;
  directoryMode: number;
} {
  return scope === 'user'
    ? { modeForNew: 0o600, directoryMode: 0o700 }
    : { modeForNew: 0o644, directoryMode: 0o755 };
}

export class CodexHookInstaller {
  constructor(
    private port: number,
    private token: string,
    private relayRoot: string,
    private observer: CodexHookInstallerObserver = NOOP_OBSERVER,
  ) {}

  private currentCommand(event: CodexHookEvent, prepare: boolean): string {
    const relayConfigPath = prepare
      ? prepareHookRelayConfig({
          relayRoot: this.relayRoot,
          adapterId: 'codex-cli',
          event,
          port: this.port,
          token: this.token,
          route: routeFor(event),
        })
      : hookRelayConfigPath(this.relayRoot, 'codex-cli', event);
    return buildHookCurlCommand({
      relayConfigPath,
      tag: currentTag(event),
    });
  }

  install(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = hooksPath(opts.scope, opts.cwd);
    updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        const beforeByEvent = new Map<CodexHookEvent, HookGroup[]>();
        for (const event of CODEX_HOOK_EVENTS) {
          beforeByEvent.set(event, strictHookGroups(document, hooks, event));
        }
        const changes: HookConfigChange[] = [];
        for (const event of CODEX_HOOK_EVENTS) {
          const command = this.currentCommand(event, true);
          const before = beforeByEvent.get(event) ?? [];
          const next = withoutOwnedHookCommands(before, currentTag(event));
          const matcher = matcherFor(event);
          next.push({
            ...(matcher ? { matcher } : {}),
            hooks: [
              {
                type: 'command',
                command,
                timeout: 5,
                statusMessage: 'Reporting to Agent Deck',
              },
            ],
          });
          const change = changedHookEvent(event, before, next);
          if (change) changes.push(change);
        }
        return { changes };
      },
      updateModes(opts.scope),
    );
    return {
      installed: true,
      scope: opts.scope,
      settingsPath: path,
      installedHooks: [...CODEX_HOOK_EVENTS],
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

    updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        if (!hooks) return { changes: [] };
        const logicalHooks: JsonObject = { ...hooks };
        const changes: HookConfigChange[] = [];
        for (const event of CODEX_HOOK_EVENTS) {
          const before = strictHookGroups(document, hooks, event);
          const next = withoutOwnedHookCommands(before, currentTag(event));
          const change = changedHookEvent(event, before, next);
          if (!change) continue;
          changes.push(change);
          if (next.length === 0) delete logicalHooks[event];
          else logicalHooks[event] = next;
        }
        return changes.length > 0 && Object.keys(logicalHooks).length === 0
          ? { changes: [{ path: ['hooks'], value: undefined }] }
          : { changes };
      },
      updateModes(opts.scope),
    );
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

    try {
      const document: HookConfigDocument = readHookConfig(path);
      const hooks = hooksObject(document);
      const installed: string[] = [];
      for (const event of CODEX_HOOK_EVENTS) {
        const command = this.currentCommand(event, false);
        const groups = strictHookGroups(document, hooks, event);
        if (groups.some((group) => group.hooks.some((entry) => entry.command === command))) {
          installed.push(event);
        }
      }
      return {
        installed: installed.length === CODEX_HOOK_EVENTS.length,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: installed,
      };
    } catch (err) {
      try {
        this.observer.statusReadFailed(err);
      } catch {
        // Observation cannot change the repairable "not installed" result.
      }
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }

  }
}
