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

const CURRENT_HOOK_TAG_PREFIX = 'agent-deck-hook-v2-grok-build';

export interface GrokHookInstallerObserver {
  statusReadFailed(error: unknown): void;
}

const NOOP_OBSERVER: GrokHookInstallerObserver = {
  statusReadFailed: () => undefined,
};

export const GROK_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
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

type GrokHookEvent = (typeof GROK_HOOK_EVENTS)[number];

function hooksPath(scope: 'user' | 'project', cwd?: string): string {
  if (scope === 'user') return join(homedir(), '.grok', 'hooks', 'agent-deck.json');
  if (!cwd) throw new Error('project scope requires cwd');
  return join(cwd, '.grok', 'hooks', 'agent-deck.json');
}

function routeFor(event: GrokHookEvent): string {
  return `/hook/grok/${event.toLowerCase()}`;
}

function currentTag(event: GrokHookEvent): string {
  return `${CURRENT_HOOK_TAG_PREFIX}-${event.toLowerCase()}`;
}

function updateModes(scope: 'user' | 'project'): {
  modeForNew: number;
  directoryMode: number;
} {
  return scope === 'user'
    ? { modeForNew: 0o600, directoryMode: 0o700 }
    : { modeForNew: 0o644, directoryMode: 0o755 };
}

export class GrokHookInstaller {
  constructor(
    private port: number,
    private token: string,
    private relayRoot: string,
    private observer: GrokHookInstallerObserver = NOOP_OBSERVER,
    private homeDirectory: string = homedir(),
  ) {}

  private hooksPath(scope: 'user' | 'project', cwd?: string): string {
    if (scope === 'user') return join(this.homeDirectory, '.grok', 'hooks', 'agent-deck.json');
    return hooksPath(scope, cwd);
  }

  private currentCommand(event: GrokHookEvent, prepare: boolean): string {
    const relayConfigPath = prepare
      ? prepareHookRelayConfig({
          relayRoot: this.relayRoot,
          adapterId: 'grok-build',
          event,
          port: this.port,
          token: this.token,
          route: routeFor(event),
        })
      : hookRelayConfigPath(this.relayRoot, 'grok-build', event);
    return buildHookCurlCommand({
      relayConfigPath,
      tag: currentTag(event),
    });
  }

  install(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = this.hooksPath(opts.scope, opts.cwd);
    updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        const beforeByEvent = new Map<GrokHookEvent, HookGroup[]>();
        for (const event of GROK_HOOK_EVENTS) {
          beforeByEvent.set(event, strictHookGroups(document, hooks, event));
        }
        const changes: HookConfigChange[] = [];
        for (const event of GROK_HOOK_EVENTS) {
          const command = this.currentCommand(event, true);
          const before = beforeByEvent.get(event) ?? [];
          const next = withoutOwnedHookCommands(before, currentTag(event));
          next.push({
            hooks: [
              {
                type: 'command',
                command,
                timeout: 5,
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
      installedHooks: [...GROK_HOOK_EVENTS],
    };
  }

  uninstall(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = this.hooksPath(opts.scope, opts.cwd);
    if (!existsSync(path)) return this.emptyStatus(opts.scope, path);

    updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        if (!hooks) return { changes: [] };
        const logicalHooks: JsonObject = { ...hooks };
        const changes: HookConfigChange[] = [];
        for (const event of GROK_HOOK_EVENTS) {
          const before = strictHookGroups(document, hooks, event);
          const next = withoutOwnedHookCommands(before, currentTag(event));
          const change = changedHookEvent(event, before, next);
          if (!change) continue;
          changes.push(change);
          if (next.length === 0) delete logicalHooks[event];
          else logicalHooks[event] = next;
        }
        return changes.length > 0 && Object.keys(logicalHooks).length === 0
          ? {
              changes: [{ path: ['hooks'], value: undefined }],
              deleteFileIfRootEmpty: true,
            }
          : { changes, deleteFileIfRootEmpty: true };
      },
      updateModes(opts.scope),
    );
    return this.emptyStatus(opts.scope, path);
  }

  status(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = this.hooksPath(opts.scope, opts.cwd);
    if (!existsSync(path)) return this.emptyStatus(opts.scope, path);

    try {
      const document: HookConfigDocument = readHookConfig(path);
      const hooks = hooksObject(document);
      const installed: string[] = [];
      for (const event of GROK_HOOK_EVENTS) {
        const command = this.currentCommand(event, false);
        const groups = strictHookGroups(document, hooks, event);
        if (groups.some((group) => group.hooks.some((entry) => entry.command === command))) {
          installed.push(event);
        }
      }
      return {
        // A partial install cannot deliver the advertised hook contract. Report it as repairable.
        installed: installed.length === GROK_HOOK_EVENTS.length,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: installed,
      };
    } catch (error) {
      try {
        this.observer.statusReadFailed(error);
      } catch {
        // Diagnostics cannot change the repairable not-installed result.
      }
      return this.emptyStatus(opts.scope, path);
    }
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
