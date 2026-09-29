import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkInstalledLocalWorkerGrokCredential,
  installLocalWorkerGrokCredential,
  projectLocalWorkerGrokCredential,
  readLocalWorkerGrokCredential,
} from './provider-credential';

const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-grok-credential-')));
  roots.push(root);
  const privateRoot = join(root, 'worker-private');
  const credentialFile = join(root, 'grok-auth.json');
  mkdirSync(privateRoot, { mode: 0o700 });
  const document = {
    'xai::cached': {
      auth_mode: 'oauth',
      key: 'fixture-access-token',
      expires_at: '2999-01-01T00:00:00.000Z',
    },
  };
  writeFileSync(credentialFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  return { credentialFile, document, privateRoot };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Local Worker Grok Provider credential projection', () => {
  it('validates and atomically projects a private credential into one Worker root', async () => {
    const { credentialFile, document, privateRoot } = fixture();

    await expect(readLocalWorkerGrokCredential(credentialFile)).resolves.toEqual(document);
    const target = await installLocalWorkerGrokCredential(privateRoot, credentialFile);

    expect(target).toBe(join(privateRoot, 'provider-inference', 'grok-auth.json'));
    expect(statSync(join(privateRoot, 'provider-inference')).mode & 0o777).toBe(0o700);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(document);
    await expect(checkInstalledLocalWorkerGrokCredential(privateRoot)).resolves.toBeUndefined();
  });

  it('checks the deployed expiry independently from a fresh native source', async () => {
    const { credentialFile, document, privateRoot } = fixture();
    const target = await installLocalWorkerGrokCredential(privateRoot, credentialFile);
    writeFileSync(target, JSON.stringify({
      'xai::cached': { ...document['xai::cached'], expires_at: '2000-01-01T00:00:00.000Z' },
    }));
    await expect(readLocalWorkerGrokCredential(credentialFile)).resolves.toEqual(document);
    await expect(checkInstalledLocalWorkerGrokCredential(privateRoot)).rejects.toThrow(/expired/);
    await installLocalWorkerGrokCredential(privateRoot, credentialFile);
    await expect(checkInstalledLocalWorkerGrokCredential(privateRoot)).resolves.toBeUndefined();
  });

  it('does not treat a native login with refresh metadata as a valid installed projection', async () => {
    const { credentialFile, privateRoot } = fixture();
    const target = await installLocalWorkerGrokCredential(privateRoot, credentialFile);
    writeFileSync(target, JSON.stringify({
      'https://auth.x.ai::fixture': { auth_mode: 'oidc', key: 'fixture-token',
        refresh_token: 'host-only', expires_at: '2999-01-01T00:00:00.000Z' },
    }));
    await expect(checkInstalledLocalWorkerGrokCredential(privateRoot)).rejects.toThrow(/invalid/);
  });

  it('rejects public or schema-expanded credential files', async () => {
    const { credentialFile, privateRoot } = fixture();
    chmodSync(credentialFile, 0o644);
    await expect(readLocalWorkerGrokCredential(credentialFile)).rejects.toThrow(/0600/);

    chmodSync(credentialFile, 0o600);
    writeFileSync(credentialFile, JSON.stringify({
      'xai::cached': {
        auth_mode: 'oauth',
        key: 'fixture-access-token',
        expires_at: '2999-01-01T00:00:00.000Z',
        unexpected: true,
      },
    }), { mode: 0o600 });
    await expect(installLocalWorkerGrokCredential(privateRoot, credentialFile))
      .rejects.toThrow(/invalid or expired/);
  });

  it('projects the current Grok OIDC login without copying refresh or profile metadata', () => {
    const native = {
      'https://auth.x.ai::account-a': {
        auth_mode: 'oidc',
        key: 'current-access-token',
        expires_at: '2999-01-01T00:00:00.000Z',
        refresh_token: 'must-not-leave-the-login-file',
        email: 'operator@example.test',
        profile: { name: 'Operator' },
      },
    };

    const projected = projectLocalWorkerGrokCredential(native, 1);
    expect(projected).toEqual({
      'xai::cached': {
        auth_mode: 'oauth',
        key: 'current-access-token',
        expires_at: '2999-01-01T00:00:00.000Z',
      },
    });
    expect(JSON.stringify(projected)).not.toContain('refresh_token');
    expect(JSON.stringify(projected)).not.toContain('operator@example.test');
  });

  it('fails closed for ambiguous or expired native Grok logins', () => {
    const entry = {
      auth_mode: 'oidc',
      key: 'current-access-token',
      expires_at: '2999-01-01T00:00:00.000Z',
    };
    expect(projectLocalWorkerGrokCredential({
      'https://auth.x.ai::account-a': entry,
      'https://auth.x.ai::account-b': entry,
    }, 1)).toBeNull();
    expect(projectLocalWorkerGrokCredential({
      'https://auth.x.ai::account-a': {
        ...entry,
        expires_at: '2000-01-01T00:00:00.000Z',
      },
    }, Date.now())).toBeNull();
  });
});
