import { describe, expect, it } from 'vitest';

import {
  isRemoteConnectionClientCredential,
  isRemoteConnectionWorkerCredential,
  parseRemoteConnectionCredential,
  renderRemoteConnectionKnownHosts,
} from './connection-credential';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n';
const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH';

function credential() {
  return {
    schemaVersion: 3,
    kind: 'agent-deck-remote-connection-credential',
    label: 'Production',
    purpose: 'client',
    topology: 'full',
    instanceId: 'instance-a',
    credentialId: 'desktop-a',
    connectionScope: 'scope-desktop-a',
    endpoint: { hostname: 'core.example.test', port: 22, username: 'agentdeck' },
    hostKeys: [{ algorithm: 'ssh-ed25519', publicKey: HOST_KEY }],
    identity: { algorithm: 'ssh-ed25519', privateKey: PRIVATE_KEY },
  };
}

function currentCredential(
  purpose: 'client' | 'worker',
  topology: 'relay' | 'full' = 'relay',
) {
  const { connectionScope: _connectionScope, ...base } = credential();
  return {
    ...base,
    topology,
    purpose,
    ...(purpose === 'client' ? { connectionScope: 'scope-desktop-a' } : {}),
    ...(purpose === 'worker' ? { workerId: 'worker-a' } : {}),
  };
}

describe('remote connection credential', () => {
  it('parses the exact bundle and renders app-owned known_hosts', () => {
    const parsed = parseRemoteConnectionCredential(credential());
    expect(parsed).toMatchObject({
      schemaVersion: 3,
      topology: 'full',
      instanceId: 'instance-a',
      connectionScope: 'scope-desktop-a',
    });
    expect(renderRemoteConnectionKnownHosts(parsed)).toBe(
      `core.example.test ssh-ed25519 ${HOST_KEY}\n`,
    );
  });

  it('rejects every retired credential schema', () => {
    expect(() => parseRemoteConnectionCredential({ ...credential(), schemaVersion: 2 }))
      .toThrow('schemaVersion is unsupported');
  });

  it('accepts a purpose-locked Client credential for Full or Relay', () => {
    const full = parseRemoteConnectionCredential(currentCredential('client', 'full'));
    const relay = parseRemoteConnectionCredential(currentCredential('client'));

    expect(full).toMatchObject({
      schemaVersion: 3,
      purpose: 'client',
      topology: 'full',
      connectionScope: 'scope-desktop-a',
    });
    expect(relay).toMatchObject({ schemaVersion: 3, purpose: 'client', topology: 'relay' });
    expect(isRemoteConnectionClientCredential(full)).toBe(true);
    expect(isRemoteConnectionWorkerCredential(full)).toBe(false);
  });

  it('binds one Worker credential to Relay and a stable Worker id', () => {
    const parsed = parseRemoteConnectionCredential(currentCredential('worker'));

    expect(isRemoteConnectionWorkerCredential(parsed)).toBe(true);
    expect(isRemoteConnectionClientCredential(parsed)).toBe(false);
    expect(parsed).toMatchObject({ purpose: 'worker', topology: 'relay', workerId: 'worker-a' });
  });

  it('uses the OpenSSH bracket form for non-default ports and IPv6', () => {
    const value = credential();
    value.endpoint = { hostname: '2001:db8::1', port: 2222, username: 'agentdeck' };
    expect(renderRemoteConnectionKnownHosts(parseRemoteConnectionCredential(value))).toBe(
      `[2001:db8::1]:2222 ssh-ed25519 ${HOST_KEY}\n`,
    );
  });

  it('rejects extra fields, invalid instances, and malformed private keys', () => {
    expect(() => parseRemoteConnectionCredential({ ...credential(), secret: true })).toThrow('unexpected');
    expect(() => parseRemoteConnectionCredential({ ...credential(), instanceId: 'UPPER' })).toThrow('instanceId');
    expect(() => parseRemoteConnectionCredential({
      ...credential(), hostKeys: [{ algorithm: 'ssh-rsa', publicKey: HOST_KEY }],
    })).toThrow('host key');
    expect(() => parseRemoteConnectionCredential({
      ...credential(), identity: { algorithm: 'ssh-ed25519', privateKey: 'secret' },
    })).toThrow('identity');
    expect(() => parseRemoteConnectionCredential({
      ...currentCredential('client', 'full'),
      workerId: 'worker-a',
    })).toThrow('unexpected');
    expect(() => parseRemoteConnectionCredential({
      ...currentCredential('worker', 'full'),
    })).toThrow('Relay topology');
    expect(() => parseRemoteConnectionCredential({
      ...currentCredential('worker'),
      workerId: undefined,
    })).toThrow('invalid');
    expect(() => parseRemoteConnectionCredential({
      ...currentCredential('client', 'full'),
      topology: 'server-core',
    })).toThrow('topology');
    expect(() => parseRemoteConnectionCredential({
      ...currentCredential('client', 'full'),
      connectionScope: undefined,
    })).toThrow('invalid');
    expect(() => parseRemoteConnectionCredential({
      ...credential(), schemaVersion: 2, topology: 'server-core',
    })).toThrow('schemaVersion');
  });
});
