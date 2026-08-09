import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HookInstallerCore } from '@main/adapters/claude-code/hook-installer-core';
import { CodexHookInstaller } from '@main/adapters/codex-cli/hook-installer';
import { GrokHookInstaller } from '@main/adapters/grok-build/hook-installer';

import { installServerCoreProviderHooks } from './provider-hook-runtime';

const roots: string[] = [];
const TOKEN = 'a'.repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { home: string; relay: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'server-core-hooks-')));
  roots.push(root);
  const home = join(root, 'provider-home');
  const relay = join(root, 'state', 'hook-relay');
  mkdirSync(home, { mode: 0o700 });
  return { home, relay };
}

describe('installServerCoreProviderHooks', () => {
  it('installs only initialized adapters into their managed user scope', async () => {
    const install = vi.fn(async () => ({ installed: true }));
    await installServerCoreProviderHooks([
      { id: 'codex-cli', ok: true },
      { id: 'grok-build', ok: false, err: new Error('not initialized') },
    ], {
      get: (id) => id === 'codex-cli'
        ? { installIntegration: install } as never
        : undefined,
    });
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith({ scope: 'user' });
  });

  it('fails closed when any initialized adapter cannot confirm hook ownership', async () => {
    await expect(installServerCoreProviderHooks([
      { id: 'claude-code', ok: true },
      { id: 'codex-cli', ok: true },
    ], {
      get: (id) => ({
        installIntegration: id === 'claude-code'
          ? vi.fn(async () => ({ installed: false }))
          : vi.fn(async () => { throw new Error('tampered'); }),
      }) as never,
    })).rejects.toMatchObject({
      message: 'Server Core managed hook installation failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'Managed hook installation was not confirmed' }),
        expect.objectContaining({ message: 'tampered' }),
      ]),
    });
  });

  it('writes every managed provider config only below the injected private home', () => {
    const { home, relay } = fixture();
    const observer = { statusReadFailed: vi.fn() };
    const statuses = [
      new HookInstallerCore(47_821, TOKEN, relay, observer, home)
        .install({ scope: 'user' }),
      new CodexHookInstaller(47_821, TOKEN, relay, observer, home)
        .install({ scope: 'user' }),
      new GrokHookInstaller(47_821, TOKEN, relay, observer, home)
        .install({ scope: 'user' }),
    ];
    expect(statuses.map((status) => status.settingsPath)).toEqual([
      join(home, '.claude', 'settings.json'),
      join(home, '.codex', 'hooks.json'),
      join(home, '.grok', 'hooks', 'agent-deck.json'),
    ]);
    for (const status of statuses) {
      expect(status.settingsPath).not.toBeNull();
      expect(readFileSync(status.settingsPath!, 'utf8')).toContain('agent-deck-hook-v2-');
    }
  });
});
