import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

describe('CodexHookInstaller', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-hooks-'));
    home = join(root, 'home');
    mockHome.value = home;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs Agent Deck hooks into ~/.codex/hooks.json', async () => {
    const { CodexHookInstaller, CODEX_HOOK_EVENTS } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47821, 'token-abc');

    const status = installer.install({ scope: 'user' });
    const path = join(home, '.codex', 'hooks.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };

    expect(status).toMatchObject({
      installed: true,
      scope: 'user',
      settingsPath: path,
      installedHooks: [...CODEX_HOOK_EVENTS],
    });
    expect(data.hooks.PreToolUse[0].matcher).toBe('.*');
    expect(data.hooks.Stop[0].matcher).toBeUndefined();
    expect(data.hooks.SessionStart[0].hooks[0].command).toContain('/hook/codex/sessionstart');
    expect(data.hooks.PreToolUse[0].hooks[0].command).toContain('# agent-deck-hook');
  });

  it('replaces old Agent Deck entries and preserves user hooks', async () => {
    const hooksPath = join(home, '.codex', 'hooks.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command:
                      "cat | curl -X POST http://127.0.0.1:47821/hook/pretooluse # agent-deck-hook",
                  },
                ],
              },
              {
                matcher: '^Bash$',
                hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }],
              },
            ],
          },
          custom: true,
        },
        null,
        2,
      ),
      'utf8',
    );

    const { CodexHookInstaller } = await import('../hook-installer');
    new CodexHookInstaller(47821, 'new-token').install({ scope: 'user' });

    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      custom?: boolean;
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(data.custom).toBe(true);
    expect(data.hooks.PreToolUse).toHaveLength(2);
    expect(data.hooks.PreToolUse[0].matcher).toBe('^Bash$');
    expect(data.hooks.PreToolUse[0].hooks[0].command).toBe('/usr/local/bin/user-hook');
    expect(data.hooks.PreToolUse[1].matcher).toBe('.*');
    expect(data.hooks.PreToolUse[1].hooks[0].command).toContain('/hook/codex/pretooluse');
    expect(data.hooks.PreToolUse[1].hooks[0].command).toContain('new-token');
  });

  it('uninstalls only Agent Deck hooks', async () => {
    const { CodexHookInstaller } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47821, 'token-abc');
    installer.install({ scope: 'user' });

    const hooksPath = join(home, '.codex', 'hooks.json');
    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    data.hooks.PreToolUse.unshift({
      matcher: '^Bash$',
      hooks: [{ command: '/usr/local/bin/user-hook' }],
    });
    writeFileSync(hooksPath, JSON.stringify(data, null, 2) + '\n', 'utf8');

    const status = installer.uninstall({ scope: 'user' });
    const after = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };

    expect(status.installed).toBe(false);
    expect(after.hooks.PreToolUse).toEqual([
      {
        matcher: '^Bash$',
        hooks: [{ command: '/usr/local/bin/user-hook' }],
      },
    ]);
    expect(after.hooks.SessionStart).toBeUndefined();
  });

  it('supports project scoped hooks.json', async () => {
    const project = join(root, 'repo');
    const { CodexHookInstaller } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47821, 'token-abc');

    const status = installer.install({ scope: 'project', cwd: project });
    expect(status.settingsPath).toBe(join(project, '.codex', 'hooks.json'));
    expect(status.installed).toBe(true);
  });

  it('tolerates malformed hook shapes while installing and checking status', async () => {
    const hooksPath = join(home, '.codex', 'hooks.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: '^Bash$' }],
            PreToolUse: 'not-an-array',
            PostToolUse: [{ matcher: '^Read$', hooks: 'not-an-array' }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const { CodexHookInstaller } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47821, 'token-abc');

    expect(() => installer.status({ scope: 'user' })).not.toThrow();
    expect(() => installer.install({ scope: 'user' })).not.toThrow();

    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(data.hooks.SessionStart.at(-1)?.hooks[0].command).toContain('/hook/codex/sessionstart');
    expect(data.hooks.PreToolUse.at(-1)?.hooks[0].command).toContain('/hook/codex/pretooluse');
  });
});
