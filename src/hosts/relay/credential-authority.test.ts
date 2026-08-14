import { describe, expect, it } from 'vitest';

import {
  encodeRelayCredentialAuthority,
  parseRelayCredentialAuthority,
} from './credential-authority';

const credential = {
  id: 'desktop-a',
  instanceId: 'instance-a',
  credentialId: 'desktop-a',
  kind: 'ssh-client' as const,
  publicKey: 'ssh-ed25519 AAAATEST desktop-a',
  fingerprint: 'SHA256:desktop-a',
  status: 'active' as const,
  createdAt: 1,
  revokedAt: null,
};

describe('Relay credential authority', () => {
  it('round-trips the standalone mutable authority document', () => {
    const encoded = encodeRelayCredentialAuthority('instance-a', [credential]);
    expect(parseRelayCredentialAuthority(JSON.parse(encoded), 'instance-a')).toEqual({
      schemaVersion: 1,
      instanceId: 'instance-a',
      credentials: [credential],
    });
    expect(encoded).not.toContain('tickIntervalMs');
    expect(encoded).not.toContain('plumbingModule');
  });

  it('rejects a foreign instance and duplicate history', () => {
    const document = JSON.parse(encodeRelayCredentialAuthority('instance-a', [credential]));
    expect(() => parseRelayCredentialAuthority(document, 'instance-b')).toThrow('instance mismatch');
    document.credentials.push({ ...document.credentials[0] });
    expect(() => parseRelayCredentialAuthority(document, 'instance-a')).toThrow('duplicates');
  });
});
