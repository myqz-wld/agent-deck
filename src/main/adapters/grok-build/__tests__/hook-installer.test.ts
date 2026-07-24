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

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'agent-deck-grok-hooks-'));
    home = join(root, 'home');
    mockHome.value = home;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs native Grok hooks into a private dedicated file', async () => {
    const { GrokHookInstaller, GROK_HOOK_EVENTS } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47821, 'token-abc');

    const status = installer.install({ scope: 'user' });
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
    };

    expect(status).toEqual({
      installed: true,
      scope: 'user',
      settingsPath: path,
      installedHooks: [...GROK_HOOK_EVENTS],
    });
    expect(data.hooks.SessionStart[0].hooks[0].command).toContain(
      '/hook/grok/sessionstart',
    );
    expect(data.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      'X-Agent-Deck-Origin: ${AGENT_DECK_ORIGIN:-cli}',
    );
    expect(data.hooks.StopFailure[0].hooks[0].command).toContain(
      'X-Agent-Deck-Parent-Pid: ${PPID:-}',
    );
    expect(data.hooks.SessionEnd[0].hooks[0].command).toContain(
      '# agent-deck-grok-hook',
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('replaces owned entries while preserving unrelated fields and hooks', async () => {
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    mkdirSync(join(home, '.grok', 'hooks'), { recursive: true });
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
              hooks: [{ type: 'command', command: 'old # agent-deck-grok-hook' }],
            },
          ],
        },
      }),
      'utf8',
    );

    const { GrokHookInstaller } = await import('../hook-installer');
    new GrokHookInstaller(47821, 'new-token').install({ scope: 'user' });

    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      custom: { keep: boolean };
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(data.custom).toEqual({ keep: true });
    expect(data.hooks.PreToolUse).toHaveLength(2);
    expect(data.hooks.PreToolUse[0]).toMatchObject({
      matcher: '^Bash$',
      hooks: [{ command: '/usr/local/bin/user-hook' }],
    });
    expect(data.hooks.PreToolUse[1].hooks[0].command).toContain('new-token');
  });

  it('uninstalls only owned entries and removes an otherwise empty owned file', async () => {
    const { GrokHookInstaller } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47821, 'token-abc');
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    installer.install({ scope: 'user' });

    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      custom?: boolean;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    data.hooks.PreToolUse.unshift({
      hooks: [{ command: '/usr/local/bin/user-hook' }],
    });
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
    ]);
    expect(after.hooks.SessionStart).toBeUndefined();

    rmSync(path);
    installer.install({ scope: 'user' });
    installer.uninstall({ scope: 'user' });
    expect(existsSync(path)).toBe(false);
  });

  it('supports project scope and coerces malformed hook event shapes', async () => {
    const project = join(root, 'repo');
    const path = join(project, '.grok', 'hooks', 'agent-deck.json');
    mkdirSync(join(project, '.grok', 'hooks'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '.*' }],
          PreToolUse: 'not-an-array',
          PostToolUse: [{ hooks: 'not-an-array' }],
        },
      }),
      'utf8',
    );

    const { GrokHookInstaller } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47821, 'token-abc');
    const status = installer.install({ scope: 'project', cwd: project });
    expect(status.settingsPath).toBe(path);
    expect(installer.status({ scope: 'project', cwd: project }).installed).toBe(true);
  });

  it('reports malformed JSON as not installed without overwriting it', async () => {
    const path = join(home, '.grok', 'hooks', 'agent-deck.json');
    mkdirSync(join(home, '.grok', 'hooks'), { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');

    const { GrokHookInstaller } = await import('../hook-installer');
    const installer = new GrokHookInstaller(47821, 'token-abc');
    expect(installer.status({ scope: 'user' }).installed).toBe(false);
    expect(() => installer.install({ scope: 'user' })).toThrow(/parse failed/);
    expect(readFileSync(path, 'utf8')).toBe('{not-json');
  });
});
