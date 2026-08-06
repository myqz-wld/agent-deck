import {
  chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseRemoteConnectionCredential } from '@shared/remote-host';

import { issueRelayConnection } from './connection-issuer';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('issueRelayConnection', () => {
  it('generates the bundle and enrolls matching Relay config and forced key', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-relay-issue-')));
    roots.push(root);
    const config = join(root, 'config.json');
    const authorizedKeys = join(root, 'authorized_keys');
    const hostKey = join(root, 'ssh_host_ed25519_key.pub');
    const output = join(root, 'relay.agentdeck-connection');
    writeFileSync(config, `${JSON.stringify({
      schemaVersion: 1, instanceId: 'instance-a', tickIntervalMs: 1000,
      plumbingModule: null, credentials: [{
        credentialId: 'worker-a', instanceId: 'instance-a', kind: 'relay-worker',
        publicKey: null, fingerprint: 'SHA256:worker-a', status: 'active',
        createdAt: 1, revokedAt: null,
      }],
    })}\n`, { mode: 0o600 });
    writeFileSync(authorizedKeys, '', { mode: 0o600 });
    writeFileSync(hostKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH host\n', { mode: 0o644 });
    chmodSync(config, 0o600);
    chmodSync(authorizedKeys, 0o600);
    chmodSync(hostKey, 0o644);

    issueRelayConnection({
      '--instance': 'instance-a', '--credential': 'desktop-a', '--label': 'Relay',
      '--hostname': 'relay.example.test', '--port': '2222', '--username': 'agentdeck',
      '--host-key': hostKey, '--config': config, '--authorized-keys': authorizedKeys,
      '--runtime-uid': '1001', '--output': output,
    });

    const bundle = parseRemoteConnectionCredential(JSON.parse(readFileSync(output, 'utf8')));
    expect(bundle).toMatchObject({ topology: 'relay', credentialId: 'desktop-a' });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const updated = JSON.parse(readFileSync(config, 'utf8')) as {
      credentials: Array<Record<string, unknown>>;
    };
    expect(updated.credentials).toHaveLength(2);
    expect(updated.credentials[0]).toMatchObject({
      credentialId: 'worker-a', kind: 'relay-worker', status: 'active',
    });
    expect(updated.credentials[0]).not.toHaveProperty('id');
    expect(updated.credentials[1]).toMatchObject({
      credentialId: 'desktop-a', kind: 'ssh-client', status: 'active',
    });
    const authorized = readFileSync(authorizedKeys, 'utf8');
    expect(authorized).toContain('/run/user/1001/agent-deck-relay/instance-a/control.sock');
    expect(authorized).not.toContain('OPENSSH PRIVATE KEY');
  });
});
