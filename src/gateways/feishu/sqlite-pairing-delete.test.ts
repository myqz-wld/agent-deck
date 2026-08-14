import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FeishuGatewayBinding } from '@gateways/im';
import { SqliteFeishuGatewayStore } from './sqlite-store';

const binding: FeishuGatewayBinding = {
  appId: 'cli_0123456789abcdef',
  tenantKey: 'tenant_1',
  instanceId: 'instance-1',
  topology: 'full',
};
const configured = {
  openId: null,
  credentialId: 'credential_1',
  connectionScope: 'scope_credential_1',
  replacesCredentialId: null,
  status: 'active' as const,
};

function databasePath(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-pair-'))), 'metadata.sqlite3');
}

function pairingInput(codeHash = 'a'.repeat(64)) {
  return {
    instanceId: binding.instanceId,
    appId: binding.appId,
    tenantKey: binding.tenantKey,
    openId: 'ou_owner_1',
    chatId: 'oc_chat_1',
    displayName: 'Owner',
    eventId: 'event_pair_1',
    codeHash,
    requestId: 'request_pair_1',
    now: 101,
  };
}

describe('Feishu pairing and deletion metadata state machines', () => {
  it('keeps an unapproved open-id outside the credential directory and persists approval', () => {
    const path = databasePath();
    const store = new SqliteFeishuGatewayStore(path, binding);
    store.reconcileCredentials([configured]);
    expect(store.listActiveCredentials()).toEqual([]);
    store.createPairingCode({
      instanceId: binding.instanceId,
      codeId: 'code_1',
      codeHash: 'a'.repeat(64),
      status: 'active',
      expiresAt: 1_000,
      createdAt: 100,
      consumedAt: null,
      consumedEventId: null,
    });
    expect(store.consumePairingCode(pairingInput('b'.repeat(64)))).toEqual({
      state: 'invalid', request: null,
    });
    const accepted = store.consumePairingCode(pairingInput());
    expect(accepted).toMatchObject({
      state: 'accepted',
      request: { status: 'pending', openId: 'ou_owner_1', credentialId: null },
    });
    expect(store.listActiveCredentials()).toEqual([]);
    expect(store.consumePairingCode(pairingInput())).toMatchObject({
      state: 'duplicate', request: { requestId: 'request_pair_1' },
    });
    expect(store.consumePairingCode({
      ...pairingInput(), eventId: 'event_pair_other', requestId: 'request_pair_other',
    })).toEqual({ state: 'invalid', request: null });

    expect(store.decidePairingRequest('request_pair_1', 'approve', 102)).toMatchObject({
      state: 'approved',
      request: { credentialId: configured.credentialId, status: 'approved' },
    });
    expect(store.resolveCredential({
      appId: binding.appId,
      tenantKey: binding.tenantKey,
      openId: 'ou_owner_1',
    })).toMatchObject({ credentialId: configured.credentialId, status: 'active' });
    store.close();

    const reopened = new SqliteFeishuGatewayStore(path, binding);
    reopened.reconcileCredentials([configured]);
    expect(reopened.listActiveCredentials()).toMatchObject([{ openId: 'ou_owner_1' }]);
    expect(reopened.listPairingRequests()).toMatchObject([{ status: 'approved' }]);
    reopened.close();
  });

  it('expires pairing codes and approval requests without granting Core access', () => {
    const store = new SqliteFeishuGatewayStore(databasePath(), binding);
    store.reconcileCredentials([configured]);
    store.createPairingCode({
      instanceId: binding.instanceId,
      codeId: 'code_expired',
      codeHash: 'c'.repeat(64),
      status: 'active',
      expiresAt: 110,
      createdAt: 100,
      consumedAt: null,
      consumedEventId: null,
    });
    expect(store.consumePairingCode({
      ...pairingInput('c'.repeat(64)), now: 110,
    })).toEqual({ state: 'expired', request: null });
    expect(store.listActiveCredentials()).toEqual([]);
    store.close();
  });

  it('rate-limits pairing-code replacement and invalidates the prior code', () => {
    const store = new SqliteFeishuGatewayStore(databasePath(), binding);
    store.reconcileCredentials([configured]);
    store.createPairingCode({
      instanceId: binding.instanceId,
      codeId: 'code_first',
      codeHash: 'e'.repeat(64),
      status: 'active',
      expiresAt: 600_100,
      createdAt: 100,
      consumedAt: null,
      consumedEventId: null,
    });
    expect(() => store.createPairingCode({
      instanceId: binding.instanceId,
      codeId: 'code_too_soon',
      codeHash: 'f'.repeat(64),
      status: 'active',
      expiresAt: 601_000,
      createdAt: 1_000,
      consumedAt: null,
      consumedEventId: null,
    })).toThrow(expect.objectContaining({ code: 'rate_limited', retryable: true }));
    store.createPairingCode({
      instanceId: binding.instanceId,
      codeId: 'code_next',
      codeHash: '1'.repeat(64),
      status: 'active',
      expiresAt: 630_100,
      createdAt: 30_100,
      consumedAt: null,
      consumedEventId: null,
    });
    expect(store.consumePairingCode({
      ...pairingInput('e'.repeat(64)), now: 30_101,
    })).toEqual({ state: 'expired', request: null });
    store.close();
  });

  it('expires deletion confirmation at its exact deadline', () => {
    const store = new SqliteFeishuGatewayStore(databasePath(), binding);
    store.reconcileCredentials([{ ...configured, openId: 'ou_owner_1' }]);
    store.createDeleteConfirmation({
      instanceId: binding.instanceId,
      confirmationId: 'confirmation_deadline',
      tokenHash: '2'.repeat(64),
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      openId: 'ou_owner_1',
      sessionId: 'session_1',
      expectedArchived: false,
      expectedUpdatedAt: 2,
      status: 'pending',
      claimEventId: null,
      claimExpiresAt: null,
      expiresAt: 110,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(store.claimDeleteConfirmation({
      instanceId: binding.instanceId,
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      openId: 'ou_owner_1',
      tokenHash: '2'.repeat(64),
      eventId: 'delete_deadline',
      now: 110,
      claimLifetimeMs: 60_000,
    })).toMatchObject({ state: 'expired' });
    store.close();
  });

  it('leases one deletion claim and atomically clears only the confirmed session metadata', () => {
    const path = databasePath();
    const store = new SqliteFeishuGatewayStore(path, binding);
    store.reconcileCredentials([{ ...configured, openId: 'ou_owner_1' }]);
    store.putContext({
      instanceId: binding.instanceId,
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      chatType: 'p2p',
      openId: 'ou_owner_1',
      activeSessionId: 'session_1',
      updatedAt: 100,
    });
    store.putSubscription({
      instanceId: binding.instanceId,
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      sessionId: 'session_1',
      status: 'active',
      updatedAt: 100,
    });
    store.createDeleteConfirmation({
      instanceId: binding.instanceId,
      confirmationId: 'confirmation_1',
      tokenHash: 'd'.repeat(64),
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      openId: 'ou_owner_1',
      sessionId: 'session_1',
      expectedArchived: false,
      expectedUpdatedAt: 2,
      status: 'pending',
      claimEventId: null,
      claimExpiresAt: null,
      expiresAt: 1_000,
      createdAt: 100,
      updatedAt: 100,
    });
    const input = {
      instanceId: binding.instanceId,
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      openId: 'ou_owner_1',
      tokenHash: 'd'.repeat(64),
      eventId: 'delete_event_1',
      now: 101,
      claimLifetimeMs: 10,
    };
    expect(store.claimDeleteConfirmation(input)).toMatchObject({ state: 'claimed' });
    expect(store.claimDeleteConfirmation({
      ...input, eventId: 'delete_event_2', now: 105,
    })).toMatchObject({ state: 'in-progress' });
    expect(store.claimDeleteConfirmation({
      ...input, eventId: 'delete_event_2', now: 111,
    })).toMatchObject({ state: 'claimed', record: { claimEventId: 'delete_event_2' } });
    expect(store.completeDeleteConfirmation(
      binding.instanceId, 'confirmation_1', 'delete_event_1', 112,
    )).toBe(false);
    expect(store.completeDeleteConfirmation(
      binding.instanceId, 'confirmation_1', 'delete_event_2', 112,
    )).toBe(true);
    expect(store.getContext(binding.instanceId, configured.credentialId, 'oc_chat_1'))
      .toMatchObject({ activeSessionId: null });
    expect(store.listSubscriptions(
      binding.instanceId, configured.credentialId, 'oc_chat_1',
    )).toEqual([]);
    expect(store.claimDeleteConfirmation({
      ...input, eventId: 'delete_event_3', now: 113,
    })).toMatchObject({ state: 'completed' });
    store.close();
    expect(readFileSync(path).includes(Buffer.from('unused-plaintext-delete-token'))).toBe(false);
  });

  it('moves current metadata across a configured credential rotation and its rollback', () => {
    const path = databasePath();
    const old = new SqliteFeishuGatewayStore(path, binding);
    old.reconcileCredentials([{ ...configured, openId: 'ou_owner_1' }]);
    old.putContext({
      instanceId: binding.instanceId,
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      chatType: 'p2p',
      openId: 'ou_owner_1',
      activeSessionId: 'session_1',
      updatedAt: 100,
    });
    old.putSubscription({
      instanceId: binding.instanceId,
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      sessionId: 'session_1',
      status: 'active',
      updatedAt: 100,
    });
    old.putCursor({
      instanceId: binding.instanceId,
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      revision: 7,
      updatedAt: 100,
    });
    old.claimDelivery({
      instanceId: binding.instanceId,
      eventId: 'event_1',
      credentialId: configured.credentialId,
      chatId: 'oc_chat_1',
      updatedAt: 100,
    }, 3);
    old.close();

    const next = new SqliteFeishuGatewayStore(path, binding);
    next.reconcileCredentials([{
      openId: 'ou_owner_1',
      credentialId: 'credential_2',
      connectionScope: 'scope_credential_2',
      replacesCredentialId: configured.credentialId,
      status: 'active',
    }]);
    expect(next.listActiveCredentials()).toMatchObject([{ credentialId: 'credential_2' }]);
    expect(next.getContext(binding.instanceId, 'credential_2', 'oc_chat_1'))
      .toMatchObject({ activeSessionId: 'session_1' });
    expect(next.listSubscriptions(binding.instanceId, 'credential_2', 'oc_chat_1'))
      .toMatchObject([{ sessionId: 'session_1' }]);
    expect(next.getCursor(binding.instanceId, 'credential_2', 'oc_chat_1'))
      .toMatchObject({ revision: 7 });
    expect(next.getDelivery(binding.instanceId, 'event_1'))
      .toMatchObject({ credentialId: 'credential_2' });
    next.close();

    const rolledBack = new SqliteFeishuGatewayStore(path, binding);
    rolledBack.reconcileCredentials([{
      ...configured,
      openId: 'ou_owner_1',
      replacesCredentialId: 'credential_2',
    }]);
    expect(rolledBack.listActiveCredentials()).toMatchObject([{
      credentialId: configured.credentialId,
    }]);
    expect(rolledBack.getContext(binding.instanceId, configured.credentialId, 'oc_chat_1'))
      .toMatchObject({ activeSessionId: 'session_1' });
    rolledBack.close();
  });
});
