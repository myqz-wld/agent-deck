import { lstatSync, mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { FeishuGatewayBinding } from '@gateways/im';
import { feishuMetadataColumns } from './sqlite-schema';
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
  replacesCredentialId: null,
  status: 'active' as const,
};

function databasePath(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-db-'))), 'metadata.sqlite3');
}

function open(path = databasePath()): SqliteFeishuGatewayStore {
  const store = new SqliteFeishuGatewayStore(path, binding);
  store.reconcileCredentials([enrolled]);
  return store;
}

function deliveryInput(updatedAt: number) {
  return {
    instanceId: binding.instanceId,
    eventId: 'evt_1',
    credentialId: enrolled.credentialId,
    chatId: 'oc_chat_1',
    updatedAt,
  };
}

function context(store: SqliteFeishuGatewayStore): void {
  store.putContext({
    instanceId: binding.instanceId,
    credentialId: enrolled.credentialId,
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    openId: enrolled.openId,
    activeSessionId: 'session_1',
    updatedAt: 100,
  });
}

describe('production metadata-only SQLite store', () => {
  it('creates an owner-only exact schema with no business-body columns', () => {
    const path = databasePath();
    const store = open(path);
    context(store);
    store.putSubscription({
      instanceId: binding.instanceId,
      credentialId: enrolled.credentialId,
      chatId: 'oc_chat_1',
      sessionId: 'session_1',
      status: 'active',
      updatedAt: 101,
    });
    store.close();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const columns = Object.values(feishuMetadataColumns()).flat();
    expect(columns.some((column) =>
      /body|text|card|action|payload|history|diff|blob|secret|frame|content|message_id/i.test(column)
    )).toBe(false);
    const db = new Database(path, { readonly: true });
    const tables = (db.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual([
      'contexts', 'credentials', 'cursors', 'delete_confirmations', 'deliveries', 'health',
      'pairing_codes', 'pairing_requests', 'subscriptions',
    ]);
    db.close();
    expect(readFileSync(path).includes(Buffer.from('private business body'))).toBe(false);
  });

  it('restores crash state and requires explicit reconciliation after unknown invocation', () => {
    const path = databasePath();
    const first = open(path);
    const claim = first.claimDelivery(deliveryInput(100), 3, 10);
    expect(first.markDeliveryPreTransport(binding.instanceId, 'evt_1', 1, 101)).toBe(true);
    expect(first.markDeliveryTransportInvoked(
      binding.instanceId, 'evt_1', 1, 'unknown', null, 102,
    )).toBe(true);
    first.close();

    const recovered = open(path);
    const replay = recovered.claimDelivery(deliveryInput(111), 3, 10);
    expect(claim.state).toBe('claimed');
    expect(replay).toMatchObject({
      state: 'reconciliation-required',
      record: { attempts: 1, status: 'reconciling', phase: 'transport-invoked' },
    });
    expect(recovered.requireDeliveryReconciliation(binding.instanceId, 'evt_1', 1, 112)).toBe(true);
    expect(recovered.claimDelivery(deliveryInput(113), 3, 10).state).toBe('exhausted');
    recovered.close();
  });

  it('retries a crash-expired event only when transport safety is event-idempotent', () => {
    const store = open();
    store.claimDelivery(deliveryInput(100), 3, 10);
    store.markDeliveryPreTransport(binding.instanceId, 'evt_1', 1, 101);
    store.markDeliveryTransportInvoked(binding.instanceId, 'evt_1', 1, 'safe', 3_702, 102);
    expect(store.claimDelivery(deliveryInput(110), 3, 10)).toMatchObject({
      state: 'claimed',
      record: {
        attempts: 2, status: 'pending', phase: 'core', transportSafety: null,
      },
    });
    store.close();
  });

  it('uses immediate transactions so competing handles cannot both claim one generation', () => {
    const path = databasePath();
    const first = open(path);
    const second = new SqliteFeishuGatewayStore(path, binding);
    const one = first.claimDelivery(deliveryInput(100), 3, 1_000);
    const two = second.claimDelivery(deliveryInput(100), 3, 1_000);
    expect(one.state).toBe('claimed');
    expect(two).toMatchObject({ state: 'in-progress', record: { attempts: 1 } });
    expect(second.finishDelivery(binding.instanceId, 'evt_1', 2, 'sent', 101)).toBe(false);
    expect(first.finishDelivery(binding.instanceId, 'evt_1', 1, 'sent', 101)).toBe(true);
    expect(second.claimDelivery(deliveryInput(102), 3).state).toBe('duplicate');
    first.close();
    second.close();
  });

  it('recovers a proven non-accepted attempt with same-attempt CAS', () => {
    const store = open();
    store.claimDelivery(deliveryInput(100), 3, 10);
    store.markDeliveryPreTransport(binding.instanceId, 'evt_1', 1, 101);
    store.markDeliveryTransportInvoked(binding.instanceId, 'evt_1', 1, 'unknown', null, 102);
    expect(store.claimDelivery(deliveryInput(111), 3, 10).state).toBe('reconciliation-required');
    expect(store.markDeliveryNotAccepted(binding.instanceId, 'evt_1', 1, 112)).toBe(true);
    expect(store.getDelivery(binding.instanceId, 'evt_1')).toMatchObject({
      status: 'failed', phase: 'pre-transport', transportSafety: null,
    });
    expect(store.claimDelivery(deliveryInput(113), 3, 10)).toMatchObject({
      state: 'claimed', record: { attempts: 2 },
    });
    store.close();
  });

  it('rechecks revocation durably and deletes selected context, subscriptions, and cursor', () => {
    const path = databasePath();
    const store = open(path);
    context(store);
    store.putSubscription({
      instanceId: binding.instanceId,
      credentialId: enrolled.credentialId,
      chatId: 'oc_chat_1',
      sessionId: 'session_1',
      status: 'active',
      updatedAt: 101,
    });
    store.putCursor({
      instanceId: binding.instanceId,
      credentialId: enrolled.credentialId,
      chatId: 'oc_chat_1',
      revision: 7,
      updatedAt: 102,
    });
    store.reconcileCredentials([{ ...enrolled, status: 'revoked' }]);
    expect(store.resolveCredential({
      appId: binding.appId, tenantKey: binding.tenantKey, openId: enrolled.openId,
    })).toMatchObject({ status: 'revoked' });
    expect(store.listActiveCredentials()).toEqual([]);
    expect(store.listContexts()).toEqual([]);
    expect(store.listSubscriptions(binding.instanceId, enrolled.credentialId, 'oc_chat_1')).toEqual([]);
    expect(store.getCursor(binding.instanceId, enrolled.credentialId, 'oc_chat_1')).toBeNull();
    store.close();

    const reopened = new SqliteFeishuGatewayStore(path, binding);
    expect(reopened.listActiveCredentials()).toEqual([]);
    reopened.close();
  });

  it('persists monotonic cursor and connection health metadata across restart', () => {
    const path = databasePath();
    const store = open(path);
    context(store);
    store.putCursor({
      instanceId: binding.instanceId,
      credentialId: enrolled.credentialId,
      chatId: 'oc_chat_1',
      revision: 9,
      updatedAt: 100,
    });
    expect(() => store.putCursor({
      instanceId: binding.instanceId,
      credentialId: enrolled.credentialId,
      chatId: 'oc_chat_1',
      revision: 8,
      updatedAt: 101,
    })).toThrow(expect.objectContaining({ code: 'cursor_regression' }));
    store.putHealth({
      instanceId: binding.instanceId,
      state: 'reconnecting',
      generation: 3,
      reconnectAttempts: 2,
      lastErrorCode: null,
      updatedAt: 102,
    });
    store.close();
    const reopened = open(path);
    expect(reopened.getCursor(binding.instanceId, enrolled.credentialId, 'oc_chat_1'))
      .toMatchObject({ revision: 9 });
    expect(reopened.getHealth(binding.instanceId)).toMatchObject({
      state: 'reconnecting', generation: 3, reconnectAttempts: 2,
    });
    reopened.close();
  });

  it('rejects invalid writes and tampered connection health rows on read', () => {
    const path = databasePath();
    const store = open(path);
    const valid = {
      instanceId: binding.instanceId,
      state: 'connected' as const,
      generation: 3,
      reconnectAttempts: 2,
      lastErrorCode: null,
      updatedAt: 102,
    };
    expect(() => store.putHealth({ ...valid, generation: -1 })).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );
    expect(() => store.putHealth({ ...valid, instanceId: 'foreign-instance' })).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );
    expect(() => store.putHealth({
      ...valid,
      state: 'failed',
      lastErrorCode: null,
    })).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
    store.putHealth(valid);
    store.close();

    const raw = new Database(path);
    raw.prepare(`UPDATE health SET generation = -1 WHERE instance_id = ?`)
      .run(binding.instanceId);
    raw.close();
    const reopened = open(path);
    expect(() => reopened.getHealth(binding.instanceId)).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );
    reopened.close();
  });

  it('rejects an attempt to rebind a stable identity or credential id', () => {
    const store = open();
    expect(() => store.reconcileCredentials([{
      openId: enrolled.openId,
      credentialId: 'credential_other',
      connectionScope: 'credential_other',
      replacesCredentialId: null,
      status: 'active',
    }])).toThrow(expect.objectContaining({ code: 'identity_conflict' }));
    expect(() => store.reconcileCredentials([{
      openId: 'ou_owner_other',
      credentialId: enrolled.credentialId,
      connectionScope: enrolled.connectionScope,
      replacesCredentialId: null,
      status: 'active',
    }])).toThrow(expect.objectContaining({ code: 'identity_conflict' }));
    store.close();
  });
});
