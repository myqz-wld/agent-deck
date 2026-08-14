import {
  chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseRemoteConnectionCredential } from '@shared/remote-host';

import { issueRelayWorkerConnection } from './connection-issuer';

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH host\n';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(credentials: readonly Record<string, unknown>[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-relay-issue-')));
  roots.push(root);
  const config = join(root, 'config.json');
  const authorizedKeys = join(root, 'authorized_keys');
  const hostKey = join(root, 'ssh_host_ed25519_key.pub');
  writeFileSync(config, `${JSON.stringify({
    schemaVersion: 1,
    instanceId: 'instance-a',
    tickIntervalMs: 1000,
    plumbingModule: null,
    credentials,
  })}\n`, { mode: 0o600 });
  writeFileSync(authorizedKeys, '', { mode: 0o600 });
  writeFileSync(hostKey, HOST_KEY, { mode: 0o644 });
  chmodSync(config, 0o600);
  chmodSync(authorizedKeys, 0o600);
  chmodSync(hostKey, 0o644);
  return { root, config, authorizedKeys, hostKey };
}

function common(fixturePaths: ReturnType<typeof fixture>, output: string) {
  return {
    '--instance': 'instance-a',
    '--label': 'Relay',
    '--hostname': 'relay.example.test',
    '--port': '2222',
    '--username': 'agentdeck',
    '--host-key': fixturePaths.hostKey,
    '--config': fixturePaths.config,
    '--authorized-keys': fixturePaths.authorizedKeys,
    '--runtime-uid': '1001',
    '--output': output,
  };
}

describe('Relay connection issuance', () => {
  it('issues one terminal-only Worker credential bound only to attach', () => {
    const paths = fixture();
    const output = join(paths.root, 'worker.agentdeck-connection');

    issueRelayWorkerConnection({
      ...common(paths, output),
      '--credential': 'worker-credential-a',
      '--worker': 'worker-a',
    });

    const credential = parseRemoteConnectionCredential(JSON.parse(readFileSync(output, 'utf8')));
    expect(credential).toMatchObject({
      schemaVersion: 3,
      purpose: 'worker',
      topology: 'relay',
      credentialId: 'worker-credential-a',
      workerId: 'worker-a',
    });
    const updated = JSON.parse(readFileSync(paths.config, 'utf8')) as {
      credentials: Array<Record<string, unknown>>;
    };
    expect(updated.credentials).toEqual([
      expect.objectContaining({
        credentialId: 'worker-credential-a', kind: 'relay-worker', status: 'active',
      }),
    ]);
    const authorized = readFileSync(paths.authorizedKeys, 'utf8');
    expect(authorized).toContain('agent-deck-relay attach');
    expect(authorized).toContain('--worker worker-a');
    expect(authorized).not.toContain('--surface desktop');
  });

  it('rejects a second active Worker identity', () => {
    const paths = fixture();
    issueRelayWorkerConnection({
      ...common(paths, join(paths.root, 'worker-a.agentdeck-connection')),
      '--credential': 'worker-credential-a',
      '--worker': 'worker-a',
    });
    expect(() => issueRelayWorkerConnection({
      ...common(paths, join(paths.root, 'worker-b.agentdeck-connection')),
      '--credential': 'worker-credential-b',
      '--worker': 'worker-b',
    })).toThrow('one active Worker');

    const updated = JSON.parse(readFileSync(paths.config, 'utf8')) as {
      credentials: Array<{ kind: string }>;
    };
    expect(updated.credentials.map((entry) => entry.kind)).toEqual(['relay-worker']);
  });
});
