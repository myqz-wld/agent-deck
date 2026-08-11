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
  installLocalWorkerGrokCredential,
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
});
