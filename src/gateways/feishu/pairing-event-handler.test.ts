import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATEWAY_CLOCK,
  type FeishuGatewayBinding,
  type FeishuMessageEvent,
} from '@gateways/im';
import { FakeTransport } from '@gateways/im/__tests__/fixture';
import { createFeishuAuditBundle } from './audit';
import { FeishuPairingEventHandler } from './pairing-event-handler';
import { SqliteFeishuGatewayStore } from './sqlite-store';

const binding: FeishuGatewayBinding = {
  appId: 'cli_0123456789abcdef',
  tenantKey: 'tenant_1',
  instanceId: 'instance-1',
  topology: 'relay',
};

function path(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-feishu-event-'))), 'metadata.sqlite3');
}

function event(eventId: string, text: string): FeishuMessageEvent {
  return {
    schemaVersion: 1,
    kind: 'message',
    eventId,
    appId: binding.appId,
    tenantKey: binding.tenantKey,
    openId: 'ou_owner_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    occurredAt: 100,
    text,
  };
}

describe('Feishu pairing event handler', () => {
  it('consumes one code without granting Core access before local approval', async () => {
    const databasePath = path();
    const store = new SqliteFeishuGatewayStore(databasePath, binding);
    store.reconcileCredentials([{
      openId: null,
      credentialId: 'credential-1',
      connectionScope: 'scope-credential-1',
      replacesCredentialId: null,
      status: 'active',
    }]);
    const token = 'A'.repeat(32);
    store.createPairingCode({
      instanceId: binding.instanceId,
      codeId: 'code-1',
      codeHash: createHash('sha256').update(token).digest('hex'),
      status: 'active',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      consumedAt: null,
      consumedEventId: null,
    });
    const transport = new FakeTransport();
    const audit = createFeishuAuditBundle(binding, DEFAULT_GATEWAY_CLOCK, () => undefined);
    const handler = new FeishuPairingEventHandler(
      store,
      transport,
      binding,
      DEFAULT_GATEWAY_CLOCK,
      audit,
      2_800,
    );
    const accepted = await handler.handle(event('pair-event-1', `/pair ${token}`));
    expect(accepted?.code).toBe('pairing_pending');
    expect(store.listActiveCredentials()).toEqual([]);
    expect(store.listPairingRequests('pending')).toMatchObject([{
      openId: 'ou_owner_1', status: 'pending', credentialId: null,
    }]);
    expect(transport.messages.at(-1)?.text).toMatch(/服务器上批准请求/);
    expect(readFileSync(databasePath).includes(Buffer.from(token))).toBe(false);

    const replay = await handler.handle(event('pair-event-1', `/pair ${token}`));
    expect(replay?.code).toBe('pairing_pending');
    expect(store.listPairingRequests()).toHaveLength(1);
    const stolen = await handler.handle(event('pair-event-2', `/pair ${token}`));
    expect(stolen?.code).toBe('invalid_confirmation');
    expect(store.listActiveCredentials()).toEqual([]);

    const requestId = store.listPairingRequests('pending')[0]?.requestId as string;
    expect(store.decidePairingRequest(requestId, 'approve', Date.now())).toMatchObject({
      state: 'approved',
    });
    expect(store.listActiveCredentials()).toMatchObject([{ openId: 'ou_owner_1' }]);
    store.close();
  });

  it('rejects malformed and group pairing without consuming a code', async () => {
    const store = new SqliteFeishuGatewayStore(path(), binding);
    store.reconcileCredentials([{
      openId: null,
      credentialId: 'credential-1',
      connectionScope: 'scope-credential-1',
      replacesCredentialId: null,
      status: 'active',
    }]);
    const transport = new FakeTransport();
    const handler = new FeishuPairingEventHandler(
      store,
      transport,
      binding,
      DEFAULT_GATEWAY_CLOCK,
      createFeishuAuditBundle(binding, DEFAULT_GATEWAY_CLOCK, () => undefined),
      2_800,
    );
    expect((await handler.handle({
      ...event('pair-group', `/pair ${'B'.repeat(32)}`), chatType: 'group',
    }))?.code).toBe('invalid_command');
    expect((await handler.handle(event('ordinary', '/help')))).toBeNull();
    expect(store.listPairingRequests()).toEqual([]);
    store.close();
  });
});
