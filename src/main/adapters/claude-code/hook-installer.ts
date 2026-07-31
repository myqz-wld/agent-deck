import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { HookInstallStatus } from '@shared/types';
import log from '@main/utils/logger';
import { buildHookCurlCommand } from '@main/hook-server/curl-command';
import {
  changedHookEvent,
  hooksObject,
  readHookConfig,
  strictHookGroups,
  updateHookConfig,
  type HookConfigChange,
  type HookConfigDocument,
  type HookGroup,
  type JsonObject,
} from '@main/hook-server/hook-config-file';
import {
  hookRelayConfigPath,
  prepareHookRelayConfig,
} from '@main/hook-server/hook-relay-config';

const logger = log.scope('claude-hook-installer');

/**
 * 在 ~/.claude/settings.json 或 <cwd>/.claude/settings.json 中
 * 注入/卸载本应用使用的 Claude Code hook。
 *
 * Hook config stores no bearer token. Commands reference private relay curl configs under
 * Agent Deck userData; ownership requires the exact adapter/event v2 command.
 */

const CURRENT_HOOK_TAG_PREFIX = 'agent-deck-hook-v2-claude-code';

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

type HookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

function routeFor(event: HookEvent): string {
  return `/hook/${event.toLowerCase()}`;
}

function currentTag(event: HookEvent): string {
  return `${CURRENT_HOOK_TAG_PREFIX}-${event.toLowerCase()}`;
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

function cleanedGroups(
  groups: HookGroup[],
  currentCommand: string,
): HookGroup[] {
  return groups
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((hook) => hook.command !== currentCommand),
    }))
    .filter((group) => group.hooks.length > 0);
}

function updateModes(scope: 'user' | 'project'): {
  modeForNew: number;
  directoryMode: number;
} {
  return scope === 'user'
    ? { modeForNew: 0o600, directoryMode: 0o700 }
    : { modeForNew: 0o644, directoryMode: 0o755 };
}

export class HookInstaller {
  constructor(
    private port: number,
    private token: string,
    private relayRoot: string,
  ) {}

  private currentCommand(event: HookEvent, prepare: boolean): string {
    const relayConfigPath = prepare
      ? prepareHookRelayConfig({
          relayRoot: this.relayRoot,
          adapterId: 'claude-code',
          event,
          port: this.port,
          token: this.token,
          route: routeFor(event),
        })
      : hookRelayConfigPath(this.relayRoot, 'claude-code', event);
    return buildHookCurlCommand({
      relayConfigPath,
      tag: currentTag(event),
      skipWhenEnvironmentSet: 'GROK_HOOK_EVENT',
    });
  }

  install(opts: { scope: 'user' | 'project'; cwd?: string }): HookInstallStatus {
    const path = settingsPath(opts.scope, opts.cwd);
    updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        const activeBefore = new Map<HookEvent, HookGroup[]>();
        for (const event of CLAUDE_HOOK_EVENTS) {
          activeBefore.set(event, strictHookGroups(document, hooks, event));
        }

        const changes: HookConfigChange[] = [];
        for (const event of CLAUDE_HOOK_EVENTS) {
          const command = this.currentCommand(event, true);
          const before = activeBefore.get(event) ?? [];
          const next = cleanedGroups(before, command);
          const matcher = [
            'PreToolUse',
            'PermissionRequest',
            'PostToolUse',
            'PostToolUseFailure',
            'PermissionDenied',
          ].includes(event)
            ? '*'
            : undefined;
          next.push({
            ...(matcher ? { matcher } : {}),
            hooks: [{ type: 'command', command }],
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
      installedHooks: [...CLAUDE_HOOK_EVENTS],
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
    updateHookConfig(
      path,
      (document) => {
        const hooks = hooksObject(document);
        if (!hooks) return { changes: [] };
        const logicalHooks: JsonObject = { ...hooks };
        const changes: HookConfigChange[] = [];
        for (const event of CLAUDE_HOOK_EVENTS) {
          const before = strictHookGroups(document, hooks, event);
          const next = cleanedGroups(
            before,
            this.currentCommand(event, false),
          );
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
    const path = settingsPath(opts.scope, opts.cwd);
    if (!existsSync(path)) {
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }
    // Status is read-only and degrades malformed files to a repairable "not installed" state.
    let document: HookConfigDocument;
    try {
      document = readHookConfig(path);
      const hooks = hooksObject(document);
      const installed: string[] = [];
      for (const event of CLAUDE_HOOK_EVENTS) {
        const command = this.currentCommand(event, false);
        const groups = strictHookGroups(document, hooks, event);
        if (groups.some((group) => group.hooks.some((entry) => entry.command === command))) {
          installed.push(event);
        }
      }
      return {
        installed: installed.length === CLAUDE_HOOK_EVENTS.length,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: installed,
      };
    } catch (err) {
      logger.warn('[hook-installer] status readHookConfig failed:', err);
      return {
        installed: false,
        scope: opts.scope,
        settingsPath: path,
        installedHooks: [],
      };
    }
  }
}
