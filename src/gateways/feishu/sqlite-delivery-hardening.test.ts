import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { FeishuGatewayBinding } from '@gateways/im';
import { SqliteFeishuGatewayStore } from './sqlite-store';

const binding: FeishuGatewayBinding = {
  appId: 'cli_0123456789abcdef',
  tenantKey: 'tenant_1',
  instanceId: 'instance-1',
  topology: 'relay',
};
const enrolled = {
  openId: 'ou_owner_1',
  credentialId: 'credential_1',
  connectionScope: 'credential_1',
  status: 'active' as const,
};

function databasePath(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-hardening-'))), 'db.sqlite3');
}

function open(
  path = databasePath(),
  storeBinding: FeishuGatewayBinding = binding,
): SqliteFeishuGatewayStore {
  const store = new SqliteFeishuGatewayStore(path, storeBinding);
  store.reconcileCredentials([enrolled]);
  return store;
}

function input(eventId: string, updatedAt: number) {
  return {
    instanceId: binding.instanceId,
    eventId,
    credentialId: enrolled.credentialId,
    chatId: 'oc_chat_1',
    updatedAt,
  };
}

function invokeSafe(
  store: SqliteFeishuGatewayStore,
  eventId: string,
  expiresAt: number,
): void {
  store.claimDelivery(input(eventId, 0), 3, 10);
  expect(store.markDeliveryPreTransport(binding.instanceId, eventId, 1, 1)).toBe(true);
  expect(store.markDeliveryTransportInvoked(
    binding.instanceId,
    eventId,
    1,
    'safe',
    expiresAt,
    2,
  )).toBe(true);
}

const LEGACY_V1 = `
CREATE TABLE credentials (
  app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, open_id TEXT NOT NULL,
  instance_id TEXT NOT NULL, credential_id TEXT NOT NULL,
  topology TEXT NOT NULL CHECK (topology IN ('relay', 'server-core')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  authority TEXT NOT NULL CHECK (authority = 'owner-equivalent'),
  PRIMARY KEY (app_id, tenant_key, open_id), UNIQUE (instance_id, credential_id)
) STRICT;
CREATE TABLE contexts (
  instance_id TEXT NOT NULL, credential_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  open_id TEXT NOT NULL, active_session_id TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, credential_id, chat_id),
  FOREIGN KEY (instance_id, credential_id)
    REFERENCES credentials(instance_id, credential_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE subscriptions (
  instance_id TEXT NOT NULL, credential_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')), updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, credential_id, chat_id, session_id),
  FOREIGN KEY (instance_id, credential_id, chat_id)
    REFERENCES contexts(instance_id, credential_id, chat_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE deliveries (
  instance_id TEXT NOT NULL, event_id TEXT NOT NULL, credential_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('deduplicated', 'exhausted', 'failed', 'pending', 'reconciling', 'sent')
  ), attempts INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('core', 'pre-transport', 'transport-invoked')),
  transport_safety TEXT CHECK (transport_safety IN ('safe', 'unknown')),
  attempt_deadline_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, event_id)
) STRICT;
CREATE TABLE cursors (
  instance_id TEXT NOT NULL, credential_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, credential_id, chat_id),
  FOREIGN KEY (instance_id, credential_id, chat_id)
    REFERENCES contexts(instance_id, credential_id, chat_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE health (
  instance_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('connected', 'failed', 'reconnecting', 'starting', 'stopped')),
  generation INTEGER NOT NULL, reconnect_attempts INTEGER NOT NULL,
  last_error_code TEXT, updated_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 1;
`;

function seedLegacyV1(
  path: string,
  storeBinding: FeishuGatewayBinding = binding,
  storedTopology: 'relay' | 'server-core' = 'relay',
): void {
  const db = new Database(path);
  db.exec(LEGACY_V1);
  db.prepare(`INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      storeBinding.appId,
      storeBinding.tenantKey,
      enrolled.openId,
      storeBinding.instanceId,
      enrolled.credentialId,
      storedTopology,
      enrolled.status,
      'owner-equivalent',
    );
  db.prepare(`INSERT INTO contexts VALUES (?, ?, ?, ?, ?, ?)`)
    .run(storeBinding.instanceId, enrolled.credentialId, 'oc_chat_1', enrolled.openId, null, 1);
  db.prepare(`INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      storeBinding.instanceId,
      'legacy-safe',
      enrolled.credentialId,
      'oc_chat_1',
      'pending',
      1,
      'transport-invoked',
      'safe',
      10,
      2,
    );
  db.close();
  chmodSync(path, 0o600);
}

describe('SQLite delivery horizon and schema boundary', () => {
  it('never resends a safe invocation after restart beyond the one-hour provider horizon', () => {
    const path = databasePath();
    const first = open(path);
    invokeSafe(first, 'six-hour-replay', 3_602);
    expect(first.markDeliveryTransportInvoked(
      binding.instanceId,
      'six-hour-replay',
      1,
      'safe',
      3_700,
      100,
    )).toBe(true);
    expect(first.getDelivery(binding.instanceId, 'six-hour-replay'))
      .toMatchObject({ transportIdempotencyExpiresAt: 3_602 });
    expect(first.finishDelivery(
      binding.instanceId,
      'six-hour-replay',
      1,
      'failed',
      101,
    )).toBe(true);
    first.close();

    const recovered = open(path);
    const exhaustedAt = 6 * 60 * 60 * 1_000;
    expect(recovered.claimDelivery(input('six-hour-replay', exhaustedAt), 3, 10))
      .toMatchObject({
        state: 'exhausted',
        record: {
          attempts: 1,
          status: 'exhausted',
          transportIdempotencyExpiresAt: 3_602,
          updatedAt: exhaustedAt,
        },
      });
    expect(recovered.markDeliveryPreTransport(
      binding.instanceId,
      'six-hour-replay',
      1,
      6 * 60 * 60 * 1_000 + 1,
    )).toBe(false);
    expect(recovered.finishDelivery(
      binding.instanceId,
      'six-hour-replay',
      1,
      'sent',
      6 * 60 * 60 * 1_000 + 1,
    )).toBe(false);
    recovered.close();

    const repeated = open(path);
    expect(repeated.claimDelivery(input('six-hour-replay', exhaustedAt + 1_000), 3, 10))
      .toMatchObject({ state: 'exhausted', record: { updatedAt: exhaustedAt } });
    repeated.close();
  });

  it('rejects retired metadata without mutating it', () => {
    const path = databasePath();
    const fullBinding = { ...binding, topology: 'full' as const };
    seedLegacyV1(path, fullBinding, 'server-core');
    expect(() => open(path, fullBinding)).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );

    const db = new Database(path, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare(`SELECT topology FROM credentials`).get()).toEqual({
      topology: 'server-core',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('prunes old terminal rows but preserves pending and reconciling crash evidence', () => {
    const store = open();
    store.claimDelivery(input('pending-old', 0), 3, 1_000);
    store.claimDelivery(input('reconciling-old', 0), 3, 10);
    store.markDeliveryPreTransport(binding.instanceId, 'reconciling-old', 1, 1);
    store.markDeliveryTransportInvoked(
      binding.instanceId,
      'reconciling-old',
      1,
      'unknown',
      null,
      2,
    );
    store.claimDelivery(input('reconciling-old', 10), 3, 10);
    const sent = store.claimDelivery(input('sent-old', 0), 3, 10);
    store.finishDelivery(binding.instanceId, 'sent-old', sent.record.attempts, 'sent', 20);

    expect(store.pruneDeliveries(100)).toBe(1);
    expect(store.getDelivery(binding.instanceId, 'sent-old')).toBeNull();
    expect(store.getDelivery(binding.instanceId, 'pending-old')?.status).toBe('pending');
    expect(store.getDelivery(binding.instanceId, 'reconciling-old')?.status).toBe('reconciling');
    store.close();
  });
});
