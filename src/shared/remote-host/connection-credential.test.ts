import { describe, expect, it } from 'vitest';

import { parseRemoteConnectionCredential, renderRemoteConnectionKnownHosts } from './connection-credential';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nQUFBQQ==\n-----END OPENSSH PRIVATE KEY-----\n';
const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH';

function credential() {
  return {
    schemaVersion: 1,
    kind: 'agent-deck-remote-connection-credential',
    label: 'Production',
    topology: 'server-core',
    instanceId: 'instance-a',
    credentialId: 'desktop-a',
    endpoint: { hostname: 'core.example.test', port: 22, username: 'agentdeck' },
    hostKeys: [{ algorithm: 'ssh-ed25519', publicKey: HOST_KEY }],
    identity: { algorithm: 'ssh-ed25519', privateKey: PRIVATE_KEY },
  };
}

describe('remote connection credential', () => {
  it('parses the exact bundle and renders app-owned known_hosts', () => {
    const parsed = parseRemoteConnectionCredential(credential());
    expect(parsed).toMatchObject({ topology: 'server-core', instanceId: 'instance-a' });
    expect(renderRemoteConnectionKnownHosts(parsed)).toBe(
      `core.example.test ssh-ed25519 ${HOST_KEY}\n`,
    );
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
  });
});
