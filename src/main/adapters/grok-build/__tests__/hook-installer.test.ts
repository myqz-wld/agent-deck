import {
  existsSync,
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
const TOKEN = 'c'.repeat(64);

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

describe('GrokHookInstaller', () => {
  let root: string;
  let home: string;
  let relayRoot: string;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'agent-deck-grok-hooks-'));
    home = join(root, 'home');
    relayRoot = join(root, 'user-data', 'hook-relay');
    mockHome.value = home;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs tokenless native hooks backed by private relay configs', async () => {
    const { GrokHookInstaller, GROK_HOOK_EVENTS } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47_821, TOKEN, relayRoot);

    const status = installer.install({ scope: 'user' });
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    const text = readFileSync(path, 'utf8');
    const data = JSON.parse(text) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
    };
    const command = data.hooks.SessionStart[0].hooks[0].command;
    const relayPath = join(relayRoot, 'grok-build-sessionstart.curlrc');
    const relay = readFileSync(relayPath, 'utf8');

    expect(status).toEqual({
      installed: true,
      scope: 'user',
      settingsPath: path,
      installedHooks: [...GROK_HOOK_EVENTS],
    });
    expect(command).toContain(`--config '${relayPath}'`);
    expect(command).toContain(
      'X-Agent-Deck-Origin: ${AGENT_DECK_ORIGIN:-cli}',
    );
    expect(command).toContain('X-Agent-Deck-Parent-Pid: ${PPID:-}');
    expect(command).toContain('> /dev/null');
    expect(command).toContain('|| true');
    expect(command).toContain(
      '# agent-deck-hook-v2-grok-build-sessionstart',
    );
    expect(text).not.toContain(TOKEN);
    expect(relay).toContain('/hook/grok/sessionstart');
    expect(relay).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(relay).toContain('fail-with-body');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(relayRoot).mode & 0o777).toBe(0o700);
    expect(statSync(relayPath).mode & 0o777).toBe(0o600);
  });

  it('does not claim historical tags after the one-time migration', async () => {
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    mkdirSync(join(home, '.grok', 'hooks'), { recursive: true });
    const collision = 'echo "owned by the user" # agent-deck-grok-hook';
    writeFileSync(
      path,
      JSON.stringify({
        custom: { keep: true },
        hooks: {
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }],
            },
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'curl http://127.0.0.1:47821/hook/grok/pretooluse # agent-deck-grok-hook',
                },
              ],
            },
            {
              hooks: [{ type: 'command', command: collision }],
            },
          ],
        },
      }),
      'utf8',
    );

    const { GrokHookInstaller } = await import('../hook-installer');
    new GrokHookInstaller(47_821, 'd'.repeat(64), relayRoot).install({
      scope: 'user',
    });

    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      custom: { keep: boolean };
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(data.custom).toEqual({ keep: true });
    expect(data.hooks.PreToolUse).toHaveLength(4);
    expect(data.hooks.PreToolUse[0]).toMatchObject({
      matcher: '^Bash$',
      hooks: [{ command: '/usr/local/bin/user-hook' }],
    });
    expect(data.hooks.PreToolUse[1].hooks[0].command).toBe(
      'curl http://127.0.0.1:47821/hook/grok/pretooluse # agent-deck-grok-hook',
    );
    expect(data.hooks.PreToolUse[2].hooks[0].command).toBe(collision);
    expect(data.hooks.PreToolUse[3].hooks[0].command).toContain(
      'agent-deck-hook-v2-grok-build-pretooluse',
    );
  });

  it('uninstalls only exact owned entries and removes an otherwise empty owned file', async () => {
    const { GrokHookInstaller } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47_821, TOKEN, relayRoot);
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    installer.install({ scope: 'user' });

    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      custom?: boolean;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const collision = 'echo "# agent-deck-grok-hook"';
    data.hooks.PreToolUse.unshift(
      { hooks: [{ command: '/usr/local/bin/user-hook' }] },
      { hooks: [{ command: collision }] },
    );
    data.custom = true;
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');

    installer.uninstall({ scope: 'user' });
    const after = JSON.parse(readFileSync(path, 'utf8')) as {
      custom: boolean;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(after.custom).toBe(true);
    expect(after.hooks.PreToolUse).toEqual([
      { hooks: [{ command: '/usr/local/bin/user-hook' }] },
      { hooks: [{ command: collision }] },
    ]);
    expect(after.hooks.SessionStart).toBeUndefined();

    rmSync(path);
    installer.install({ scope: 'user' });
    installer.uninstall({ scope: 'user' });
    expect(existsSync(path)).toBe(false);
  });

  it('supports project scope with a conventional shared config mode', async () => {
    const project = join(root, 'repo');
    const { GrokHookInstaller } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47_821, TOKEN, relayRoot);
    const status = installer.install({ scope: 'project', cwd: project });
    const projectHooksPath = join(
      project,
      '.grok',
      'hooks',
      'agent-deck.json',
    );

    expect(status.settingsPath).toBe(projectHooksPath);
    expect(status.installed).toBe(true);
    expect(statSync(projectHooksPath).mode & 0o777).toBe(0o644);
  });

  it('fails closed on malformed hook shapes without changing bytes', async () => {
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    mkdirSync(join(home, '.grok', 'hooks'), { recursive: true });
    const original = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '.*' }],
        PreToolUse: 'not-an-array',
        PostToolUse: [{ hooks: 'not-an-array' }],
      },
    });
    writeFileSync(path, original, 'utf8');

    const { GrokHookInstaller } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47_821, TOKEN, relayRoot);
    expect(installer.status({ scope: 'user' })).toMatchObject({
      installed: false,
      installedHooks: [],
    });
    expect(() => installer.install({ scope: 'user' })).toThrow(
      /must contain a hooks array|must be an array/,
    );
    expect(() => installer.uninstall({ scope: 'user' })).toThrow(
      /must contain a hooks array|must be an array/,
    );
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('reports malformed JSON as not installed without overwriting it', async () => {
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    mkdirSync(join(home, '.grok', 'hooks'), { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');

    const { GrokHookInstaller } = await import('../hook-installer');
    const parseFailure = vi.fn((_error: unknown) => {
      throw new Error('diagnostic sink unavailable');
    });
    const installer = new GrokHookInstaller(47_821, TOKEN, relayRoot, {
      statusReadFailed: parseFailure,
    });
    expect(installer.status({ scope: 'user' }).installed).toBe(false);
    expect(parseFailure).toHaveBeenCalledOnce();
    expect(parseFailure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(() => installer.install({ scope: 'user' })).toThrow(/parse failed/);
    expect(readFileSync(path, 'utf8')).toBe('{not-json');
  });

  it('reports a partial v2 native hook set as needing repair', async () => {
    const { GrokHookInstaller } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47_821, TOKEN, relayRoot);
    installer.install({ scope: 'user' });
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    data.hooks = { SessionStart: data.hooks.SessionStart };
    writeFileSync(path, JSON.stringify(data), 'utf8');

    const status = installer.status({ scope: 'user' });
    expect(status.installed).toBe(false);
    expect(status.installedHooks).toEqual(['SessionStart']);
  });
});
