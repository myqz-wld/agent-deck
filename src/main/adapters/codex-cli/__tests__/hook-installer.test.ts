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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const TOKEN = 'a'.repeat(64);

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
  let relayRoot: string;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-hooks-'));
    home = join(root, 'home');
    relayRoot = join(root, 'user-data', 'hook-relay');
    mockHome.value = home;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs tokenless commands and private relay configs', async () => {
    const { CodexHookInstaller, CODEX_HOOK_EVENTS } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47_821, TOKEN, relayRoot);

    const status = installer.install({ scope: 'user' });
    const path = join(home, '.codex', 'hooks.json');
    const text = readFileSync(path, 'utf8');
    const data = JSON.parse(text) as {
      hooks: Record<string, Array<{
        matcher?: string;
        hooks: Array<{ command: string; timeout: number }>;
      }>>;
    };
    const command = data.hooks.SessionStart[0].hooks[0].command;
    const relayPath = join(relayRoot, 'codex-cli-sessionstart.curlrc');
    const relay = readFileSync(relayPath, 'utf8');

    expect(status).toMatchObject({
      installed: true,
      scope: 'user',
      settingsPath: path,
      installedHooks: [...CODEX_HOOK_EVENTS],
    });
    expect(data.hooks.PreToolUse[0].matcher).toBe('.*');
    expect(data.hooks.Stop[0].matcher).toBeUndefined();
    expect(data.hooks.SessionStart[0].hooks[0].timeout).toBe(5);
    expect(data.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(command).toContain(`--config '${relayPath}'`);
    expect(command).toContain('X-Agent-Deck-Parent-Pid: ${PPID:-}');
    expect(command).toContain('> /dev/null');
    expect(command).toContain('|| true');
    expect(command).toContain(
      '# agent-deck-hook-v2-codex-cli-sessionstart',
    );
    expect(text).not.toContain(TOKEN);
    expect(relay).toContain('/hook/codex/sessionstart');
    expect(relay).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(relay).toContain('fail-with-body');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(relayRoot).mode & 0o777).toBe(0o700);
    expect(statSync(relayPath).mode & 0o777).toBe(0o600);
  });

  it('does not claim user commands that only contain an unowned tag', async () => {
    const hooksPath = join(home, '.codex', 'hooks.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const collision =
      'echo "this user command mentions Agent Deck" # agent-deck-hook';
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
                      'cat | curl -X POST http://127.0.0.1:47821/hook/codex/pretooluse # agent-deck-hook',
                  },
                ],
              },
              {
                matcher: '^Bash$',
                hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }],
              },
              {
                hooks: [{ type: 'command', command: collision }],
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
    new CodexHookInstaller(47_821, 'b'.repeat(64), relayRoot).install({
      scope: 'user',
    });

    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      custom?: boolean;
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(data.custom).toBe(true);
    expect(data.hooks.PreToolUse).toHaveLength(4);
    expect(data.hooks.PreToolUse[0]).toMatchObject({
      matcher: '*',
      hooks: [
        {
          command:
            'cat | curl -X POST http://127.0.0.1:47821/hook/codex/pretooluse # agent-deck-hook',
        },
      ],
    });
    expect(data.hooks.PreToolUse[1]).toMatchObject({
      matcher: '^Bash$',
      hooks: [{ command: '/usr/local/bin/user-hook' }],
    });
    expect(data.hooks.PreToolUse[2].hooks[0].command).toBe(collision);
    expect(data.hooks.PreToolUse[3].matcher).toBe('.*');
    expect(data.hooks.PreToolUse[3].hooks[0].command).toContain(
      'agent-deck-hook-v2-codex-cli-pretooluse',
    );
  });

  it('replaces tagged command variants instead of appending duplicate hooks', async () => {
    const hooksPath = join(home, '.codex', 'hooks.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const tag = 'agent-deck-hook-v2-codex-cli-pretooluse';
    const userHook = '/usr/local/bin/user-hook';
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '^Bash$',
                hooks: [
                  { type: 'command', command: userHook },
                  { type: 'command', command: `curl --config '/tmp/old-a' # ${tag}` },
                ],
              },
              {
                matcher: '.*',
                hooks: [
                  { type: 'command', command: `curl --legacy '/tmp/old-b' # ${tag}` },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const { CodexHookInstaller } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47_821, TOKEN, relayRoot);
    installer.install({ scope: 'user' });

    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const preToolCommands = data.hooks.PreToolUse.flatMap((group) => group.hooks);
    expect(data.hooks.PreToolUse).toHaveLength(2);
    expect(data.hooks.PreToolUse[0]).toEqual({
      matcher: '^Bash$',
      hooks: [{ type: 'command', command: userHook }],
    });
    expect(preToolCommands.filter((hook) => hook.command.endsWith(`# ${tag}`))).toHaveLength(1);
    expect(preToolCommands.at(-1)?.command).toContain('curl --disable --config');

    data.hooks.PreToolUse[1].hooks[0].command =
      `curl --future-shape '/tmp/future' # ${tag}`;
    writeFileSync(hooksPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    installer.uninstall({ scope: 'user' });

    const after = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(after.hooks.PreToolUse).toEqual([
      {
        matcher: '^Bash$',
        hooks: [{ type: 'command', command: userHook }],
      },
    ]);
  });

  it('uninstalls only exact Agent Deck hooks', async () => {
    const { CodexHookInstaller } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47_821, TOKEN, relayRoot);
    installer.install({ scope: 'user' });

    const hooksPath = join(home, '.codex', 'hooks.json');
    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const collision = 'echo "# agent-deck-hook"';
    data.hooks.PreToolUse.unshift(
      {
        matcher: '^Bash$',
        hooks: [{ command: '/usr/local/bin/user-hook' }],
      },
      {
        hooks: [{ command: collision }],
      },
    );
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
      {
        hooks: [{ command: collision }],
      },
    ]);
    expect(after.hooks.SessionStart).toBeUndefined();
  });

  it('supports project scoped hooks.json', async () => {
    const project = join(root, 'repo');
    const { CodexHookInstaller } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47_821, TOKEN, relayRoot);

    const status = installer.install({ scope: 'project', cwd: project });
    const projectHooksPath = join(project, '.codex', 'hooks.json');
    expect(status.settingsPath).toBe(projectHooksPath);
    expect(status.installed).toBe(true);
    expect(statSync(projectHooksPath).mode & 0o777).toBe(0o644);
  });

  it('fails closed on malformed hook shapes without changing bytes', async () => {
    const hooksPath = join(home, '.codex', 'hooks.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const original = JSON.stringify(
      {
        hooks: {
          SessionStart: [{ matcher: '^Bash$' }],
          PreToolUse: 'not-an-array',
          PostToolUse: [{ matcher: '^Read$', hooks: 'not-an-array' }],
        },
      },
      null,
      2,
    );
    writeFileSync(hooksPath, original, 'utf8');

    const { CodexHookInstaller } = await import('../hook-installer');
    const observer = {
      statusReadFailed: vi.fn(() => {
        throw new Error('observer failure');
      }),
    };
    const installer = new CodexHookInstaller(
      47_821,
      TOKEN,
      relayRoot,
      observer,
    );

    expect(installer.status({ scope: 'user' })).toMatchObject({
      installed: false,
      installedHooks: [],
    });
    expect(observer.statusReadFailed).toHaveBeenCalledOnce();
    expect(() => installer.install({ scope: 'user' })).toThrow(
      /must contain a hooks array|must be an array/,
    );
    expect(() => installer.uninstall({ scope: 'user' })).toThrow(
      /must contain a hooks array|must be an array/,
    );
    expect(readFileSync(hooksPath, 'utf8')).toBe(original);
  });

  it('reports a partial v2 hook set as needing repair', async () => {
    const { CodexHookInstaller } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47_821, TOKEN, relayRoot);
    installer.install({ scope: 'user' });
    const hooksPath = join(home, '.codex', 'hooks.json');
    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    data.hooks = { SessionStart: data.hooks.SessionStart };
    writeFileSync(hooksPath, JSON.stringify(data), 'utf8');

    const status = installer.status({ scope: 'user' });
    expect(status.installed).toBe(false);
    expect(status.installedHooks).toEqual(['SessionStart']);
  });

  it('reports a legacy five-second SessionEnd hook as needing repair', async () => {
    const { CodexHookInstaller, CODEX_HOOK_EVENTS } = await import('../hook-installer');
    const installer = new CodexHookInstaller(47_821, TOKEN, relayRoot);
    installer.install({ scope: 'user' });
    const hooksPath = join(home, '.codex', 'hooks.json');
    const data = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
    };
    data.hooks.SessionEnd[0].hooks[0].timeout = 5;
    writeFileSync(hooksPath, JSON.stringify(data), 'utf8');

    const status = installer.status({ scope: 'user' });
    expect(status.installed).toBe(false);
    expect(status.installedHooks).toEqual(
      CODEX_HOOK_EVENTS.filter((event) => event !== 'SessionEnd'),
    );
  });
});
