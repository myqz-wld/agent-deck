import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseRemoteConnectionCredential } from '@shared/remote-host';

import type { ServerControlConfig } from './config';
import { ServerConnectionService } from './connection-service';

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH host\n';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(topology: 'relay' | 'full') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-server-control-')));
  roots.push(root);
  const authorityFile = join(root, 'authority.json');
  const authorizedKeysFile = join(root, 'authorized_keys');
  const hostKeyFile = join(root, 'ssh_host_ed25519_key.pub');
  const authority = topology === 'relay'
    ? {
        schemaVersion: 1,
        instanceId: 'instance-a',
        tickIntervalMs: 1_000,
        plumbingModule: null,
        credentials: [],
      }
    : { schemaVersion: 3, instanceId: 'instance-a', credentials: [] };
  writeFileSync(authorityFile, `${JSON.stringify(authority)}\n`, { mode: 0o600 });
  writeFileSync(authorizedKeysFile, 'ssh-ed25519 AAAATEST unmanaged\n', { mode: 0o600 });
  writeFileSync(hostKeyFile, HOST_KEY, { mode: 0o644 });
  chmodSync(authorityFile, 0o600);
  chmodSync(authorizedKeysFile, 0o600);
  chmodSync(hostKeyFile, 0o644);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const config: ServerControlConfig = {
    schemaVersion: 2,
    appVersion: '0.1.0',
    instanceId: 'instance-a',
    topology,
    authorityFile,
    authorizedKeysFile,
    endpoint: {
      hostname: `${topology}.example.test`,
      port: 22,
      username: 'agentdeck',
      hostKeyFile,
    },
    relayRuntimeUid: topology === 'relay' ? 1001 : null,
    feishuIdentityOwner: { uid, gid },
  };
  let now = 100;
  return {
    root,
    authorityFile,
    authorizedKeysFile,
    config,
    service: new ServerConnectionService(config, () => now++),
  };
}

describe.each(['relay', 'full'] as const)('Server connection authority: %s', (topology) => {
  it('issues equal Desktop/Feishu owner credentials without leaking private material', () => {
    const test = fixture(topology);
    const desktopOutput = join(test.root, 'desktop.agentdeck-connection');
    const feishuOutput = join(test.root, 'feishu-identity');

    const desktop = test.service.issue({
      schemaVersion: 1,
      credentialId: 'desktop-a',
      surface: 'desktop',
      label: 'Production Desktop',
      outputFile: desktopOutput,
    });
    const feishu = test.service.issue({
      schemaVersion: 1,
      credentialId: 'feishu-a',
      surface: 'feishu',
      label: 'Production Feishu',
      outputFile: feishuOutput,
    });

    expect(desktop).toMatchObject({ status: 'issued', topology, surface: 'desktop' });
    expect(feishu).toMatchObject({ status: 'issued', topology, surface: 'feishu' });
    const bundle = parseRemoteConnectionCredential(JSON.parse(readFileSync(desktopOutput, 'utf8')));
    expect(bundle).toMatchObject({ topology, credentialId: 'desktop-a', purpose: 'client' });
    expect(readFileSync(feishuOutput, 'utf8')).toContain('OPENSSH PRIVATE KEY');
    expect(statSync(desktopOutput).mode & 0o777).toBe(0o600);
    expect(statSync(feishuOutput)).toMatchObject(test.config.feishuIdentityOwner);
    const authority = readFileSync(test.authorityFile, 'utf8');
    const authorized = readFileSync(test.authorizedKeysFile, 'utf8');
    expect(`${authority}${authorized}${JSON.stringify(desktop)}${JSON.stringify(feishu)}`)
      .not.toContain('OPENSSH PRIVATE KEY');
    expect(authorized).toContain('--surface desktop');
    expect(authorized).toContain('--surface feishu');
    expect(authorized).toContain(topology === 'relay'
      ? '/opt/agent-deck/bin/agent-deck-relay bridge'
      : '/opt/agent-deck/bin/agent-deck-full-bridge');
    expect(authorized).toContain(topology === 'relay'
      ? 'command="/opt/agent-deck/bin/agent-deck-relay bridge --instance instance-a ' +
        '--credential desktop-a --surface desktop --socket /run/user/1001/' +
        'agent-deck-relay/instance-a/control.sock"'
      : 'command="/opt/agent-deck/bin/agent-deck-full-bridge --instance instance-a ' +
        '--credential desktop-a --surface desktop"');
    expect(test.service.verify()).toEqual({ topology, active: 2 });
    expect(test.service.list().credentials).toEqual([
      expect.objectContaining({ credentialId: 'desktop-a', status: 'active' }),
      expect.objectContaining({ credentialId: 'feishu-a', status: 'active' }),
    ]);
    expect(test.service.issue({
      schemaVersion: 1,
      credentialId: 'desktop-a',
      surface: 'desktop',
      label: 'Production Desktop',
      outputFile: desktopOutput,
    }).status).toBe('already-issued');
  });

  it('revokes and rotates exact credentials idempotently', () => {
    const test = fixture(topology);
    const desktopOutput = join(test.root, 'desktop.agentdeck-connection');
    test.service.issue({
      schemaVersion: 1,
      credentialId: 'desktop-a',
      surface: 'desktop',
      label: 'Desktop',
      outputFile: desktopOutput,
    });
    expect(test.service.revoke({
      schemaVersion: 1,
      credentialId: 'desktop-a',
      surface: 'desktop',
    }).status).toBe('revoked');
    expect(test.service.revoke({
      schemaVersion: 1,
      credentialId: 'desktop-a',
      surface: 'desktop',
    }).status).toBe('already-revoked');

    const sourceOutput = join(test.root, 'feishu-a');
    const nextOutput = join(test.root, 'feishu-b');
    test.service.issue({
      schemaVersion: 1,
      credentialId: 'feishu-a',
      surface: 'feishu',
      label: 'Feishu',
      outputFile: sourceOutput,
    });
    expect(test.service.rotate({
      schemaVersion: 1,
      credentialId: 'feishu-a',
      nextCredentialId: 'feishu-b',
      surface: 'feishu',
      label: 'Feishu rotated',
      outputFile: nextOutput,
    })).toMatchObject({
      status: 'rotated',
      credentialId: 'feishu-b',
      replacedCredentialId: 'feishu-a',
    });
    expect(test.service.rotate({
      schemaVersion: 1,
      credentialId: 'feishu-a',
      nextCredentialId: 'feishu-b',
      surface: 'feishu',
      label: 'Feishu rotated',
      outputFile: nextOutput,
    }).status).toBe('already-rotated');
    expect(test.service.list().credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ credentialId: 'desktop-a', status: 'revoked' }),
      expect.objectContaining({ credentialId: 'feishu-a', status: 'revoked' }),
      expect.objectContaining({ credentialId: 'feishu-b', status: 'active' }),
    ]));
    const authorized = readFileSync(test.authorizedKeysFile, 'utf8');
    expect(authorized).not.toContain('--credential desktop-a ');
    expect(authorized).not.toContain('--credential feishu-a ');
    expect(authorized).toContain('--credential feishu-b ');
    expect(test.service.verify()).toEqual({ topology, active: 1 });
  });
});

describe('Relay Worker authority isolation', () => {
  it('preserves Worker credentials and never reuses their credentialId for a client', () => {
    const test = fixture('relay');
    writeFileSync(test.authorityFile, `${JSON.stringify({
      schemaVersion: 1,
      instanceId: 'instance-a',
      tickIntervalMs: 1_000,
      plumbingModule: null,
      credentials: [{
        credentialId: 'worker-a',
        instanceId: 'instance-a',
        kind: 'relay-worker',
        publicKey: 'ssh-ed25519 AAAATEST worker-a',
        fingerprint: 'SHA256:worker-a',
        status: 'active',
        createdAt: 1,
        revokedAt: null,
      }],
    })}\n`, { mode: 0o600 });
    chmodSync(test.authorityFile, 0o600);

    expect(() => test.service.issue({
      schemaVersion: 1,
      credentialId: 'worker-a',
      surface: 'desktop',
      label: 'Collision',
      outputFile: join(test.root, 'collision.agentdeck-connection'),
    })).toThrow('non-client');
    test.service.issue({
      schemaVersion: 1,
      credentialId: 'desktop-a',
      surface: 'desktop',
      label: 'Desktop',
      outputFile: join(test.root, 'desktop.agentdeck-connection'),
    });
    const authority = readFileSync(test.authorityFile, 'utf8');
    expect(authority).toContain('"kind": "relay-worker"');
    expect(authority).toContain('"kind": "ssh-client"');
  });
});
