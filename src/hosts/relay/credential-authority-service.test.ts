import { describe, expect, it, vi } from 'vitest';

import { RelayCredentialAuthorityService } from './credential-authority-service';
import { RelayMetadataStore } from './metadata';

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

function rawAuthority(status: 'active' | 'revoked' = 'active'): unknown {
  const value = {
    schemaVersion: 1,
    instanceId: 'instance-a',
    credentials: [{
      ...credential,
      status,
      revokedAt: status === 'revoked' ? 2 : null,
    }],
  } as const;
  return {
    schemaVersion: value.schemaVersion,
    instanceId: value.instanceId,
    credentials: value.credentials.map(({ id: _id, ...entry }) => entry),
  };
}

function metadata(): RelayMetadataStore {
  const store = new RelayMetadataStore();
  store.put('instances', {
    id: 'instance-a', instanceId: 'instance-a', topology: 'relay', createdAt: 1,
  });
  store.put('credentials', credential);
  return store;
}

describe('Relay credential authority service', () => {
  it('applies live revocation and fails closed while the authority is unavailable', async () => {
    vi.useFakeTimers();
    try {
      let current: unknown = rawAuthority();
      let unavailable = false;
      const store = metadata();
      const service = new RelayCredentialAuthorityService({
        instanceId: 'instance-a',
        authorityFile: '/var/lib/agent-deck/relay/authority.json',
        metadata: store,
        pollIntervalMs: 10,
        now: () => 5,
        readConfig: async () => {
          if (unavailable) throw new Error('private authority path');
          return current;
        },
      });
      await service.start();

      current = rawAuthority('revoked');
      await vi.advanceTimersByTimeAsync(10);
      expect(store.getById('credentials', 'desktop-a')).toMatchObject({
        status: 'revoked', revokedAt: 2,
      });

      current = rawAuthority();
      await vi.advanceTimersByTimeAsync(10);
      expect(store.getById('credentials', 'desktop-a')).toMatchObject({ status: 'active' });

      unavailable = true;
      await vi.advanceTimersByTimeAsync(10);
      expect(service.healthy).toBe(false);
      expect(store.getById('credentials', 'desktop-a')).toMatchObject({
        status: 'revoked', revokedAt: 5,
      });

      unavailable = false;
      await vi.advanceTimersByTimeAsync(10);
      expect(service.healthy).toBe(true);
      expect(store.getById('credentials', 'desktop-a')).toMatchObject({ status: 'active' });
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects deletion of credential history', async () => {
    const service = new RelayCredentialAuthorityService({
      instanceId: 'instance-a',
      authorityFile: '/var/lib/agent-deck/relay/authority.json',
      metadata: metadata(),
      readConfig: async () => ({ ...rawAuthority() as Record<string, unknown>, credentials: [] }),
    });
    await expect(service.refresh()).rejects.toThrow('cannot delete credential history');
  });
});
