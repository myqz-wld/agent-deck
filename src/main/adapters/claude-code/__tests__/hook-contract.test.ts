import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import { CLAUDE_HOOK_EVENTS, HookInstaller } from '../hook-installer';
import { buildHookRoutes } from '../hook-routes';

const TOKEN = 'e'.repeat(64);

describe('Claude Code hook install/route contract', () => {
  it('keeps every active installed event routable', () => {
    const urls = buildHookRoutes(
      vi.fn(),
      new HookRouteDiagnostics(),
    ).map((route) => route.url);
    expect(urls).toEqual(
      CLAUDE_HOOK_EVENTS.map((event) => `/hook/${event.toLowerCase()}`),
    );
  });

  it('installs tokenless commands without claiming historical-looking hooks', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-claude-hooks-'));
    const relayRoot = join(cwd, 'user-data', 'hook-relay');
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
                    command:
                      'curl http://127.0.0.1:47821/hook/taskcreated # agent-deck-hook',
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

      const installer = new HookInstaller(47_821, TOKEN, relayRoot);
      const status = installer.install({ scope: 'project', cwd });
      const text = readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(text) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
      const relayPath = join(
        relayRoot,
        'claude-code-userpromptsubmit.curlrc',
      );
      const relay = readFileSync(relayPath, 'utf8');

      expect(status.installed).toBe(true);
      expect(status.installedHooks).toEqual([...CLAUDE_HOOK_EVENTS]);
      expect(settings.hooks.TaskCreated).toEqual([
        {
          hooks: [
            {
              type: 'command',
              command:
                'curl http://127.0.0.1:47821/hook/taskcreated # agent-deck-hook',
            },
          ],
        },
      ]);
      expect(settings.hooks.TeammateIdle).toEqual([
        {
          hooks: [{ type: 'command', command: '/usr/local/bin/user-owned-team-hook' }],
        },
      ]);
      expect(command).toContain(`--config '${relayPath}'`);
      expect(command).toContain('GROK_HOOK_EVENT');
      expect(command).toContain(
        '# agent-deck-hook-v2-claude-code-userpromptsubmit',
      );
      expect(text).not.toContain(TOKEN);
      expect(relay).toContain('/hook/userpromptsubmit');
      expect(relay).toContain(`Authorization: Bearer ${TOKEN}`);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o644);
      expect(statSync(relayRoot).mode & 0o777).toBe(0o700);
      expect(statSync(relayPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reports a partial v2 active contract as needing repair', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-claude-hooks-partial-'));
    const relayRoot = join(cwd, 'user-data', 'hook-relay');
    try {
      const installer = new HookInstaller(47_821, TOKEN, relayRoot);
      installer.install({ scope: 'project', cwd });
      const settingsPath = join(cwd, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: Record<string, unknown>;
      };
      settings.hooks = { SessionStart: settings.hooks.SessionStart };
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');

      const status = installer.status({ scope: 'project', cwd });
      expect(status.installed).toBe(false);
      expect(status.installedHooks).toEqual(['SessionStart']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('ignores unowned hook tags outside the active contract', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-claude-hooks-stale-'));
    const relayRoot = join(cwd, 'user-data', 'hook-relay');
    try {
      const installer = new HookInstaller(47_821, TOKEN, relayRoot);
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
              command:
                'curl http://127.0.0.1:47821/hook/taskcompleted # agent-deck-hook',
            },
          ],
        },
      ];
      writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');

      const status = installer.status({ scope: 'project', cwd });
      expect(status.installed).toBe(true);
      expect(status.installedHooks).toEqual([...CLAUDE_HOOK_EVENTS]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed shapes and preserves tag-collision user hooks', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-deck-claude-hooks-malformed-'));
    const relayRoot = join(cwd, 'user-data', 'hook-relay');
    try {
      const settingsPath = join(cwd, '.claude', 'settings.json');
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      const malformed = JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '.*' }],
          TaskCreated: 'not-an-array',
        },
      });
      writeFileSync(settingsPath, malformed, 'utf8');
      const installer = new HookInstaller(47_821, TOKEN, relayRoot);

      expect(installer.status({ scope: 'project', cwd })).toMatchObject({
        installed: false,
        installedHooks: [],
      });
      expect(() => installer.install({ scope: 'project', cwd })).toThrow(
        /must contain a hooks array|must be an array/,
      );
      expect(() => installer.uninstall({ scope: 'project', cwd })).toThrow(
        /must contain a hooks array|must be an array/,
      );
      expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);

      const collision = 'echo "user note" # agent-deck-hook';
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            TaskCreated: [{ hooks: [{ type: 'command', command: collision }] }],
          },
        }),
        'utf8',
      );
      installer.install({ scope: 'project', cwd });
      installer.uninstall({ scope: 'project', cwd });
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(after.hooks.TaskCreated[0].hooks[0].command).toBe(collision);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
