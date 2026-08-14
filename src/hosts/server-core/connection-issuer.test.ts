import {
  chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseRemoteConnectionCredential } from '@shared/remote-host';

import { issueServerCoreConnection } from './connection-issuer';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; flags: Readonly<Record<string, string>> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-server-core-issue-')));
  roots.push(root);
  const credentialFile = join(root, 'credentials.json');
  const authorizedKeys = join(root, 'authorized_keys');
  const hostKey = join(root, 'ssh_host_ed25519_key.pub');
  writeFileSync(credentialFile, `${JSON.stringify({
    schemaVersion: 2, instanceId: 'instance-a', credentials: [],
  })}\n`, { mode: 0o600 });
  writeFileSync(authorizedKeys, '', { mode: 0o600 });
  writeFileSync(hostKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH host\n', { mode: 0o644 });
  chmodSync(credentialFile, 0o600);
  chmodSync(authorizedKeys, 0o600);
  chmodSync(hostKey, 0o644);
  return {
    root,
    flags: {
      '--instance': 'instance-a',
      '--credential': 'desktop-a',
      '--label': 'Production',
      '--hostname': 'core.example.test',
      '--port': '22',
      '--username': 'agentdeck',
      '--host-key': hostKey,
      '--credential-file': credentialFile,
      '--authorized-keys': authorizedKeys,
      '--output': join(root, 'production.agentdeck-connection'),
    },
  };
}

describe('issueServerCoreConnection', () => {
  it('generates, enrolls, and exports one client credential without printing private material', () => {
    const { flags } = fixture();

    issueServerCoreConnection(flags);

    const bundle = parseRemoteConnectionCredential(JSON.parse(readFileSync(flags['--output'], 'utf8')));
    expect(bundle).toMatchObject({
      schemaVersion: 3, purpose: 'client', topology: 'full',
      instanceId: 'instance-a', credentialId: 'desktop-a',
    });
    expect(bundle).not.toHaveProperty('workerId');
    expect(statSync(flags['--output']).mode & 0o777).toBe(0o600);
    const authority = readFileSync(flags['--credential-file'], 'utf8');
    const authorized = readFileSync(flags['--authorized-keys'], 'utf8');
    expect(authority).toContain('desktop-a');
    expect(authorized).toContain('--surface desktop');
    expect(authorized).toContain('ssh-ed25519');
    expect(`${authority}${authorized}`).not.toContain('OPENSSH PRIVATE KEY');
  });

  it('refuses to overwrite an existing output or duplicate credential', () => {
    const { flags } = fixture();
    writeFileSync(flags['--output'], 'existing', { mode: 0o600 });
    expect(() => issueServerCoreConnection(flags)).toThrow('output');
  });
});
