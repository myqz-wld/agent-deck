import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileRemoteHostCredentialMaterialStore } from './credential-material-store';
import { testConnectionCredential } from './test-connection-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FileRemoteHostCredentialMaterialStore', () => {
  it('installs private material under one app-owned 0700/0600 tree and disposes it', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-credential-store-')));
    roots.push(parent);
    const root = join(parent, 'credentials');
    const store = new FileRemoteHostCredentialMaterialStore({ root, createId: () => 'id-a' });

    const material = store.install(testConnectionCredential());

    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(material.identityFile).mode & 0o777).toBe(0o600);
    expect(statSync(material.knownHostsFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(material.identityFile, 'utf8')).toContain('OPENSSH PRIVATE KEY');
    expect(readFileSync(material.knownHostsFile, 'utf8')).toContain('core.example.test ssh-ed25519');
    store.dispose(material);
    expect(statSync(material.identityFile, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(material.knownHostsFile, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('never removes a caller-selected legacy path outside its owned root', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-credential-fence-')));
    roots.push(parent);
    const external = join(parent, 'legacy-key');
    writeFileSync(external, 'legacy', { mode: 0o600 });
    chmodSync(external, 0o600);
    const store = new FileRemoteHostCredentialMaterialStore({
      root: join(parent, 'credentials'), createId: () => 'id-a',
    });

    store.dispose({ identityFile: external, knownHostsFile: external });

    expect(readFileSync(external, 'utf8')).toBe('legacy');
  });

  it('fails closed if the owned root is replaced before disposal', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-credential-swap-')));
    roots.push(parent);
    const root = join(parent, 'credentials');
    const store = new FileRemoteHostCredentialMaterialStore({ root, createId: () => 'id-a' });
    const material = store.install(testConnectionCredential());
    const displaced = join(parent, 'displaced');
    const external = join(parent, 'external');
    renameSync(root, displaced);
    mkdirSync(external, { mode: 0o700 });
    const victim = join(external, 'identity-id-a.key');
    writeFileSync(victim, 'do not remove', { mode: 0o600 });
    symlinkSync(external, root);

    expect(() => store.dispose(material)).toThrow('canonical');
    expect(readFileSync(victim, 'utf8')).toBe('do not remove');
  });
});
