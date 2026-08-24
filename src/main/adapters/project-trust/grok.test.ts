import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as TOML from '@iarna/toml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDirectGrokProjectTrustGrant,
  createGrokProjectTrustProvider,
} from './grok';

const roots: string[] = [];

function fixture() {
  const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'agent-deck-grok-trust-')));
  roots.push(home);
  const grokHome = join(home, '.grok');
  const cwd = join(home, 'work', 'repo', 'nested');
  mkdirSync(grokHome);
  mkdirSync(cwd, { recursive: true });
  return { cwd: realpathSync(cwd), grokHome, home };
}

function privateText(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Grok project trust provider', () => {
  it('uses the most-specific ancestor and a nearer deny overrides a broad grant', async () => {
    const { cwd, grokHome, home } = fixture();
    privateText(join(grokHome, 'trusted_folders.toml'), TOML.stringify({
      folders: {
        [join(home, 'work')]: { trusted: true, decided_at: 1 },
        [join(home, 'work', 'repo')]: { trusted: false, decided_at: 2 },
      },
    }));
    const provider = createGrokProjectTrustProvider({
      grokHome: () => grokHome,
      homeDirectory: () => home,
      grant: vi.fn(),
      forceFolderTrustEnabled: true,
    });
    await expect(provider.observe({ adapterId: 'grok-build', cwd })).resolves.toMatchObject({
      descriptor: { status: 'untrusted', canGrant: true },
    });
  });

  it('ignores a lexically disguised home-root grant', async () => {
    const { cwd, grokHome, home } = fixture();
    privateText(join(grokHome, 'trusted_folders.toml'), TOML.stringify({
      folders: { [`${home}/child/..`]: { trusted: true, decided_at: 1 } },
    }));
    const provider = createGrokProjectTrustProvider({
      grokHome: () => grokHome,
      homeDirectory: () => home,
      grant: vi.fn(),
      forceFolderTrustEnabled: true,
    });
    await expect(provider.observe({ adapterId: 'grok-build', cwd })).resolves.toMatchObject({
      descriptor: { status: 'untrusted', canGrant: true },
    });
  });

  it('persists the exact native folder shape, preserves unrelated state, and re-detects it', async () => {
    const { cwd, grokHome, home } = fixture();
    const statePath = join(grokHome, 'trusted_folders.toml');
    privateText(statePath, TOML.stringify({ custom: { keep: 'yes' }, folders: {} }));
    const grant = createDirectGrokProjectTrustGrant(() => 12_345);
    const provider = createGrokProjectTrustProvider({
      grokHome: () => grokHome,
      homeDirectory: () => home,
      grant,
      forceFolderTrustEnabled: true,
    });
    const observed = await provider.observe({ adapterId: 'grok-build', cwd });
    expect(observed.descriptor).toMatchObject({ status: 'untrusted', canGrant: true });
    await observed.grant?.();

    const stored = TOML.parse(readFileSync(statePath, 'utf8')) as TOML.JsonMap;
    expect(stored.custom).toEqual({ keep: 'yes' });
    expect(stored.folders).toMatchObject({
      [cwd]: { trusted: true, decided_at: 12 },
    });
    await expect(provider.observe({ adapterId: 'grok-build', cwd })).resolves.toMatchObject({
      descriptor: { status: 'trusted', canGrant: false },
    });
  });

  it('distinguishes a disabled native gate and an unsafe home-root target', async () => {
    const { cwd, grokHome, home } = fixture();
    privateText(join(grokHome, 'config.toml'), '[folder_trust]\nenabled = false\n');
    const provider = createGrokProjectTrustProvider({
      grokHome: () => grokHome,
      homeDirectory: () => home,
      grant: vi.fn(),
    });
    await expect(provider.observe({ adapterId: 'grok-build', cwd })).resolves.toMatchObject({
      descriptor: {
        status: 'unsupported', canGrant: false, reasonCode: 'policy-disabled',
      },
    });
    await expect(provider.observe({ adapterId: 'grok-build', cwd: home })).resolves.toMatchObject({
      descriptor: {
        status: 'unsupported', canGrant: false, reasonCode: 'unsafe-project-root',
      },
    });
  });

  it('reports malformed native TOML without offering a grant', async () => {
    const { cwd, grokHome, home } = fixture();
    privateText(join(grokHome, 'trusted_folders.toml'), '[folders.invalid\n');
    const provider = createGrokProjectTrustProvider({
      grokHome: () => grokHome,
      homeDirectory: () => home,
      grant: vi.fn(),
      forceFolderTrustEnabled: true,
    });
    await expect(provider.observe({ adapterId: 'grok-build', cwd })).resolves.toMatchObject({
      descriptor: { status: 'unknown', canGrant: false, reasonCode: 'state-malformed' },
    });
  });
});
