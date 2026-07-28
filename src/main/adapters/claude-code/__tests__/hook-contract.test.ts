import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_HOOK_EVENTS, HookInstaller } from '../hook-installer';
import { buildHookRoutes } from '../hook-routes';

describe('Claude hook install/route contract', () => {
  it('keeps every active installed event routable', () => {
    const urls = buildHookRoutes(vi.fn()).map((route) => route.url);
    expect(urls).toEqual(
      CLAUDE_HOOK_EVENTS.map((event) => `/hook/${event.toLowerCase()}`),
    );
  });

  it('installs the complete active contract and removes obsolete team hooks', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-claude-hooks-'));
    try {
      const settingsPath = join(cwd, '.claude', 'settings.json');
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            TaskCreated: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'curl old # agent-deck-hook',
                  },
                ],
              },
            ],
            TeammateIdle: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: '/usr/local/bin/user-owned-team-hook',
                  },
                ],
              },
            ],
          },
        }),
        'utf8',
      );

      const installer = new HookInstaller(47821, 'token-abc');
      const status = installer.install({ scope: 'project', cwd });
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };

      expect(status.installed).toBe(true);
      expect(status.installedHooks).toEqual([...CLAUDE_HOOK_EVENTS]);
      expect(settings.hooks.TaskCreated).toBeUndefined();
      expect(settings.hooks.TeammateIdle).toEqual([
        {
          hooks: [{ type: 'command', command: '/usr/local/bin/user-owned-team-hook' }],
        },
      ]);
      expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
        '/hook/userpromptsubmit',
      );
      expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toContain(
        'X-Agent-Deck-Parent-Pid: ${PPID:-}',
      );
      expect(settings.hooks.StopFailure[0].hooks[0].command).toContain(
        '/hook/stopfailure',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reports a partial active contract as needing repair', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-claude-hooks-partial-'));
    try {
      const settingsPath = join(cwd, '.claude', 'settings.json');
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command:
                      'curl http://127.0.0.1/hook/sessionstart # agent-deck-hook-grok-guard',
                  },
                ],
              },
            ],
          },
        }),
        'utf8',
      );

      const status = new HookInstaller(47821, 'token-abc').status({
        scope: 'project',
        cwd,
      });
      expect(status.installed).toBe(false);
      expect(status.installedHooks).toEqual(['SessionStart']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reports stale owned team hooks as needing repair even with every active hook present', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-claude-hooks-stale-'));
    try {
      const installer = new HookInstaller(47821, 'token-abc');
      installer.install({ scope: 'project', cwd });
      const settingsPath = join(cwd, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
      };
      settings.hooks.TaskCompleted = [
        {
          hooks: [
            {
              type: 'command',
              command: 'curl old # agent-deck-hook',
            },
          ],
        },
      ];
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');

      const status = installer.status({ scope: 'project', cwd });
      expect(status.installed).toBe(false);
      expect(status.installedHooks).toEqual([...CLAUDE_HOOK_EVENTS]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
