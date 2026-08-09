import { describe, expect, it, vi } from 'vitest';
import {
  FeishuSessionConsoleGateway,
  feishuClientId,
  type FeishuAuditRecord,
} from '.';
import {
  FakeCoreClient,
  FakeTransport,
  credential,
  flush,
  gatewayBinding,
  messageEvent,
  onlyClient,
  pending,
  select,
  setup,
  testNonce,
} from './__tests__/fixture';

function notificationInput(revision: number, updatedAt: number) {
  return {
    instanceId: credential.instanceId,
    eventId: `notify-${revision}-${feishuClientId(credential, 'chat-1')}`,
    credentialId: credential.credentialId,
    chatId: 'chat-1',
    updatedAt,
  };
}

function emit(client: FakeCoreClient, revision: number): void {
  client.emit({
    instanceId: credential.instanceId,
    revision,
    kind: 'pending.created',
    entityId: 'pending-1',
    payload: { ignored: 'business-body' },
  });
}

function expectTerminalObservation(
  observer: {
    onError: ReturnType<typeof vi.fn>;
    onDeliveryDropped: ReturnType<typeof vi.fn>;
  },
  audit: readonly FeishuAuditRecord[],
  revision: number,
): void {
  expect(observer.onError).not.toHaveBeenCalled();
  expect(observer.onDeliveryDropped).toHaveBeenCalledWith({
    chatId: 'chat-1',
    revision,
    reason: 'delivery-exhausted',
  });
  expect(audit).toContainEqual(expect.objectContaining({
    eventId: `notify-${revision}-${feishuClientId(credential, 'chat-1')}`,
    operation: 'core-notification-skip',
    outcome: 'rejected',
    code: 'delivery_exhausted',
    revision,
  }));
}

describe('terminal notification consumption', () => {
  it('advances through pre-existing exhausted delivery, keeps the lane, and survives pruning/restart', async () => {
    const audit: FeishuAuditRecord[] = [];
    const observer = { onError: vi.fn(), onDeliveryDropped: vi.fn() };
    const first = setup({ observer, audit: { record: (entry) => audit.push(entry) } });
    await select(first.gateway);
    await first.gateway.handle(messageEvent('exhausted-subscribe', '/subscribe'));
    const client = onlyClient(first.clients);
    client.pending.set('session-1', [pending()]);
    const delivery = notificationInput(11, 1);
    const claimed = first.store.claimDelivery(delivery, 1, 1);
    first.store.finishDelivery(
      credential.instanceId,
      delivery.eventId,
      claimed.record.attempts,
      'failed',
      2,
    );
    expect(first.store.claimDelivery({ ...delivery, updatedAt: 3 }, 1, 1)).toMatchObject({
      state: 'exhausted',
      record: { updatedAt: 3 },
    });
    first.transport.messages.length = 0;
    audit.length = 0;
    observer.onError.mockClear();
    observer.onDeliveryDropped.mockClear();

    emit(client, 11);
    await flush();
    await flush();
    expect(first.store.getCursor(
      credential.instanceId,
      credential.credentialId,
      'chat-1',
    )?.revision).toBe(11);
    expect(first.store.getDelivery(credential.instanceId, delivery.eventId)?.updatedAt).toBe(3);
    expect(client.closed).toBe(false);
    expectTerminalObservation(observer, audit, 11);

    emit(client, 12);
    await flush();
    await flush();
    expect(first.store.getCursor(
      credential.instanceId,
      credential.credentialId,
      'chat-1',
    )?.revision).toBe(12);
    expect(first.transport.messages.filter(
      (message) => message.eventId.startsWith('notify-12-'),
    )).toHaveLength(1);
    expect(client.closed).toBe(false);

    expect(first.store.pruneDeliveries(4)).toBe(1);
    expect(first.store.getDelivery(credential.instanceId, delivery.eventId)).toBeNull();
    await first.gateway.close();

    const restartedTransport = new FakeTransport();
    const restartedClients: FakeCoreClient[] = [];
    const restarted = new FeishuSessionConsoleGateway({
      appVersion: 'test',
      binding: gatewayBinding,
      store: first.store,
      clientFactory: (input) => {
        const restartedClient = new FakeCoreClient(input);
        restartedClient.revision = 12;
        (restartedClient.hello as { eventRevision: number }).eventRevision = 12;
        restartedClient.pending.set('session-1', [pending()]);
        restartedClients.push(restartedClient);
        return restartedClient;
      },
      transport: restartedTransport,
      nonce: testNonce,
      observer,
      audit: { record: (entry) => audit.push(entry) },
    });
    await restarted.start();
    expect(restartedClients).toHaveLength(1);
    expect(restartedClients[0]?.subscribeRevisions).toEqual([12]);
    emit(restartedClients[0]!, 13);
    await flush();
    await flush();
    expect(restartedTransport.messages.filter(
      (message) => message.eventId.startsWith('notify-13-'),
    )).toHaveLength(1);
    expect(restartedTransport.messages.some(
      (message) => message.eventId.startsWith('notify-11-'),
    )).toBe(false);
    await restarted.close();
  });

  it('consumes reconciliation-produced exhaustion once without refreshing repeated terminal metadata', async () => {
    const audit: FeishuAuditRecord[] = [];
    const observer = { onError: vi.fn(), onDeliveryDropped: vi.fn() };
    const { gateway, clients, store, transport } = setup({
      observer,
      audit: { record: (entry) => audit.push(entry) },
    });
    await select(gateway);
    await gateway.handle(messageEvent('reconciliation-subscribe', '/subscribe'));
    const client = onlyClient(clients);
    client.pending.set('session-1', [pending()]);
    const delivery = notificationInput(11, 0);
    store.claimDelivery(delivery, 3, 10);
    store.markDeliveryPreTransport(credential.instanceId, delivery.eventId, 1, 1);
    store.markDeliveryTransportInvoked(
      credential.instanceId,
      delivery.eventId,
      1,
      'unknown',
      null,
      2,
    );
    expect(store.claimDelivery({ ...delivery, updatedAt: 10 }, 3, 10).state).toBe(
      'reconciliation-required',
    );
    transport.messages.length = 0;
    audit.length = 0;
    observer.onError.mockClear();
    observer.onDeliveryDropped.mockClear();

    emit(client, 11);
    await flush();
    await flush();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision)
      .toBe(11);
    const exhaustedAt = store.getDelivery(
      credential.instanceId,
      delivery.eventId,
    )?.updatedAt;
    expect(exhaustedAt).toBeTypeOf('number');
    expect(store.claimDelivery({
      ...delivery,
      updatedAt: (exhaustedAt as number) + 1_000,
    }, 3, 10)).toMatchObject({
      state: 'exhausted',
      record: { updatedAt: exhaustedAt },
    });
    expectTerminalObservation(observer, audit, 11);

    emit(client, 12);
    await flush();
    await flush();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision)
      .toBe(12);
    expect(transport.messages.filter(
      (message) => message.eventId.startsWith('notify-12-'),
    )).toHaveLength(1);
    expect(client.closed).toBe(false);
    await gateway.close();
  });
});
