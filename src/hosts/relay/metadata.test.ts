import { describe, expect, it } from 'vitest';

import {
  RELAY_METADATA_ALLOWED_FIELDS,
  RELAY_METADATA_FORBIDDEN_FIELD_NAMES,
  RELAY_METADATA_FORBIDDEN_TABLE_NAMES,
  RELAY_METADATA_TABLES,
  RelayMetadataError,
  RelayMetadataStore,
} from './metadata';

describe('Relay metadata allowlist', () => {
  it('contains only routing, registration, stable Feishu ids/status, cursor, and health tables', () => {
    expect(RELAY_METADATA_TABLES).toEqual([
      'instances',
      'credentials',
      'workerRegistrations',
      'routes',
      'feishuContexts',
      'feishuSubscriptions',
      'feishuDeliveries',
      'reconciliationCursors',
      'health',
    ]);
    const allowedFields = Object.values(RELAY_METADATA_ALLOWED_FIELDS).flat();
    for (const forbidden of RELAY_METADATA_FORBIDDEN_FIELD_NAMES) {
      expect(allowedFields).not.toContain(forbidden);
    }
    for (const forbidden of RELAY_METADATA_FORBIDDEN_TABLE_NAMES) {
      expect(RELAY_METADATA_TABLES).not.toContain(forbidden);
    }
  });

  it('rejects forbidden tables and payload-like fields at snapshot and row boundaries', () => {
    const store = new RelayMetadataStore();
    expect(() =>
      store.put('health', {
        id: 'relay',
        instanceId: 'instance-a',
        component: 'relay',
        status: 'ok',
        checkedAt: 1,
        detailCode: null,
        messageBody: 'must never persist',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RelayMetadataError>>({
        message: 'health.messageBody is not in the Relay metadata allowlist',
      }),
    );
    expect(() =>
      RelayMetadataStore.fromSnapshot(
        JSON.stringify({
          version: 1,
          tables: Object.fromEntries([
            ...RELAY_METADATA_TABLES.map((table) => [table, []]),
            ['sessions', []],
          ]),
        }),
      ),
    ).toThrow('sessions is not an allowed Relay metadata table');
    for (const field of ['payload', 'body']) {
      expect(() =>
        RelayMetadataStore.fromSnapshot(
          JSON.stringify({
            version: 1,
            tables: Object.fromEntries(RELAY_METADATA_TABLES.map((table) => [table, []])),
            [field]: 'business data',
          }),
        ),
      ).toThrow(`snapshot.${field} is not in the Relay metadata envelope allowlist`);
    }
  });

  it('rejects primary/logical id mismatches at the row boundary', () => {
    const store = new RelayMetadataStore();
    expect(() =>
      store.put('instances', {
        id: 'row-a',
        instanceId: 'instance-a',
        topology: 'relay',
        createdAt: 1,
      }),
    ).toThrow('instances.id must equal instanceId');
    expect(() =>
      store.put('workerRegistrations', {
        id: 'instance-a',
        instanceId: 'instance-b',
        workerId: 'worker-a',
        credentialId: 'worker-credential-a',
        generation: 1,
        status: 'offline',
        registeredAt: 1,
        lastSeenAt: 1,
      }),
    ).toThrow('workerRegistrations.id must equal instanceId');
    expect(() =>
      store.put('routes', {
        id: 'row-a',
        instanceId: 'instance-a',
        routeId: 'route-a',
        accessCredentialId: 'credential-a',
        workerId: 'worker-a',
        generation: 1,
        status: 'open',
        updatedAt: 1,
      }),
    ).toThrow('routes.id must equal routeId');
  });

  it('persists public Worker credential material but rejects private key bytes', () => {
    const store = new RelayMetadataStore();
    store.put('instances', {
      id: 'instance-a',
      instanceId: 'instance-a',
      topology: 'relay',
      createdAt: 1,
    });
    store.put('credentials', {
      id: 'credential-worker',
      instanceId: 'instance-a',
      credentialId: 'credential-worker',
      kind: 'relay-worker',
      publicKey: 'ssh-ed25519 AAAATEST relay-worker',
      fingerprint: 'SHA256:test',
      status: 'active',
      createdAt: 1,
      revokedAt: null,
    });
    expect(store.exportSnapshot()).toContain('ssh-ed25519 AAAATEST');
    expect(() =>
      store.put('credentials', {
        id: 'credential-worker',
        instanceId: 'instance-a',
        credentialId: 'credential-worker',
        kind: 'relay-worker',
        publicKey: 'ssh-ed25519 -----BEGIN OPENSSH PRIVATE KEY-----',
        fingerprint: 'SHA256:test',
        status: 'active',
        createdAt: 1,
        revokedAt: null,
      }),
    ).toThrow('cannot contain private key material');
  });

  it('requires coherent credential ids and rejects duplicate snapshot rows', () => {
    const credential = {
      id: 'credential-a',
      instanceId: 'instance-a',
      credentialId: 'credential-a',
      kind: 'ssh-client' as const,
      publicKey: 'ssh-ed25519 AAAATEST',
      fingerprint: 'SHA256:test',
      status: 'active' as const,
      createdAt: 1,
      revokedAt: null,
    };
    const store = new RelayMetadataStore();
    store.put('instances', {
      id: 'instance-a',
      instanceId: 'instance-a',
      topology: 'relay',
      createdAt: 1,
    });
    expect(() => store.put('credentials', { ...credential, id: 'row-alias' })).toThrow(
      'credentials.id must equal credentialId',
    );
    expect(() =>
      RelayMetadataStore.fromSnapshot(
        JSON.stringify({
          version: 1,
          tables: {
            ...Object.fromEntries(RELAY_METADATA_TABLES.map((table) => [table, []])),
            instances: [
              { id: 'instance-a', instanceId: 'instance-a', topology: 'relay', createdAt: 1 },
            ],
            credentials: [credential, { ...credential, status: 'revoked', revokedAt: 2 }],
          },
        }),
      ),
    ).toThrow('Duplicate credentials primary id in snapshot: credential-a');
  });

  it('rejects duplicate primary ids in every snapshot table', () => {
    const health = {
      id: 'relay',
      instanceId: 'instance-a',
      component: 'relay',
      status: 'ok',
      checkedAt: 1,
      detailCode: null,
    };
    expect(() =>
      RelayMetadataStore.fromSnapshot(
        JSON.stringify({
          version: 1,
          tables: {
            ...Object.fromEntries(RELAY_METADATA_TABLES.map((table) => [table, []])),
            instances: [
              { id: 'instance-a', instanceId: 'instance-a', topology: 'relay', createdAt: 1 },
            ],
            health: [health, { ...health, checkedAt: 2 }],
          },
        }),
      ),
    ).toThrow('Duplicate health primary id in snapshot: relay');
  });

  it('enforces credential key and revocation coherence', () => {
    const store = new RelayMetadataStore();
    store.put('instances', {
      id: 'instance-a',
      instanceId: 'instance-a',
      topology: 'relay',
      createdAt: 1,
    });
    const credential = {
      id: 'credential-a',
      instanceId: 'instance-a',
      credentialId: 'credential-a',
      kind: 'ssh-client' as const,
      publicKey: 'ssh-ed25519 AAAATEST',
      fingerprint: 'SHA256:test',
      status: 'active' as const,
      createdAt: 2,
      revokedAt: null,
    };
    expect(() => store.put('credentials', { ...credential, publicKey: null })).toThrow(
      'SSH credentials require',
    );
    expect(() =>
      store.put('credentials', { ...credential, kind: 'feishu', publicKey: credential.publicKey }),
    ).toThrow('Feishu credentials cannot carry');
    expect(() => store.put('credentials', { ...credential, revokedAt: 3 })).toThrow(
      'Active credentials require null revokedAt',
    );
    expect(() =>
      store.put('credentials', { ...credential, status: 'revoked', revokedAt: null }),
    ).toThrow('Revoked credentials require revokedAt');
    expect(() =>
      store.put('credentials', { ...credential, status: 'revoked', revokedAt: 1 }),
    ).toThrow('revokedAt must be a safe integer >= 2');
  });

  it('bounds UTF-8 bytes and rejects unsafe control/token text', () => {
    const store = new RelayMetadataStore();
    const cursor = {
      id: 'cursor-a',
      instanceId: 'instance-a',
      credentialId: 'credential-a',
      chatId: 'chat-a',
      cursor: 'ok',
      updatedAt: 1,
    };
    expect(() => store.put('reconciliationCursors', { ...cursor, cursor: '€'.repeat(683) })).toThrow(
      'bounded non-empty UTF-8 string',
    );
    expect(() => store.put('reconciliationCursors', { ...cursor, cursor: 'bad\u0085text' })).toThrow(
      'forbidden control characters',
    );
    expect(() => store.put('reconciliationCursors', { ...cursor, chatId: 'chat id' })).toThrow(
      'stable token syntax',
    );
  });

  it('fails closed on instance and credential foreign-key mismatches', () => {
    expect(() =>
      new RelayMetadataStore().put('credentials', {
        id: 'orphan-credential',
        instanceId: 'instance-a',
        credentialId: 'orphan-credential',
        kind: 'ssh-client',
        publicKey: 'ssh-ed25519 AAAATEST',
        fingerprint: 'SHA256:orphan',
        status: 'active',
        createdAt: 1,
        revokedAt: null,
      }),
    ).toThrow('Missing Relay instance foreign key: instance-a');

    const store = new RelayMetadataStore();
    store.put('instances', {
      id: 'instance-a',
      instanceId: 'instance-a',
      topology: 'relay',
      createdAt: 1,
    });
    store.put('credentials', {
      id: 'credential-ssh',
      instanceId: 'instance-a',
      credentialId: 'credential-ssh',
      kind: 'ssh-client',
      publicKey: 'ssh-ed25519 AAAATEST',
      fingerprint: 'SHA256:ssh',
      status: 'active',
      createdAt: 1,
      revokedAt: null,
    });
    expect(() =>
      store.put('feishuDeliveries', {
        id: 'event-a',
        instanceId: 'instance-a',
        eventId: 'event-a',
        credentialId: 'credential-ssh',
        chatId: 'chat-a',
        status: 'sent',
        attempts: 1,
        updatedAt: 1,
      }),
    ).toThrow('Invalid credential foreign key');
    expect(() =>
      store.put('health', {
        id: 'relay',
        instanceId: 'missing-instance',
        component: 'relay',
        status: 'offline',
        checkedAt: 1,
        detailCode: null,
      }),
    ).toThrow('Missing Relay instance foreign key');

    const orphanSnapshot = JSON.parse(store.exportSnapshot()) as {
      tables: { instances: unknown[] };
    };
    orphanSnapshot.tables.instances = [];
    expect(() => RelayMetadataStore.fromSnapshot(JSON.stringify(orphanSnapshot))).toThrow(
      'Missing Relay instance foreign key: instance-a',
    );
  });

  it('requires an open route to target the current online Worker generation', () => {
    const store = new RelayMetadataStore();
    store.put('instances', {
      id: 'instance-a',
      instanceId: 'instance-a',
      topology: 'relay',
      createdAt: 1,
    });
    for (const [credentialId, kind] of [
      ['worker-credential', 'relay-worker'],
      ['client-credential', 'ssh-client'],
    ] as const) {
      store.put('credentials', {
        id: credentialId,
        instanceId: 'instance-a',
        credentialId,
        kind,
        publicKey: 'ssh-ed25519 AAAATEST',
        fingerprint: `SHA256:${credentialId}`,
        status: 'active',
        createdAt: 1,
        revokedAt: null,
      });
    }
    store.put('workerRegistrations', {
      id: 'instance-a',
      instanceId: 'instance-a',
      workerId: 'worker-a',
      credentialId: 'worker-credential',
      generation: 2,
      status: 'online',
      registeredAt: 1,
      lastSeenAt: 1,
    });
    expect(() =>
      store.put('routes', {
        id: 'route-a',
        instanceId: 'instance-a',
        routeId: 'route-a',
        accessCredentialId: 'client-credential',
        workerId: 'worker-b',
        generation: 2,
        status: 'open',
        updatedAt: 1,
      }),
    ).toThrow('Invalid Worker foreign key for route: route-a');
  });

  it('round-trips allowlisted metadata without a business payload table', () => {
    const store = new RelayMetadataStore();
    store.put('instances', {
      id: 'instance-a',
      instanceId: 'instance-a',
      topology: 'relay',
      createdAt: 1,
    });
    store.put('credentials', {
      id: 'credential-feishu',
      instanceId: 'instance-a',
      credentialId: 'credential-feishu',
      kind: 'feishu',
      publicKey: null,
      fingerprint: 'SHA256:feishu',
      status: 'active',
      createdAt: 1,
      revokedAt: null,
    });
    store.put('feishuDeliveries', {
      id: 'event-1',
      instanceId: 'instance-a',
      eventId: 'event-1',
      credentialId: 'credential-feishu',
      chatId: 'chat-1',
      status: 'sent',
      attempts: 1,
      updatedAt: 5,
    });
    const snapshot = store.exportSnapshot();
    const restored = RelayMetadataStore.fromSnapshot(snapshot);
    expect(restored.rows('feishuDeliveries')).toEqual(store.rows('feishuDeliveries'));
    expect(snapshot).not.toMatch(/messageBody|approvalInput|cardBody|sessionDatabase/);
  });
});
