import { describe, expect, it, vi } from 'vitest';
import { feishuClientId } from '.';
import {
  FakeTransport,
  credential,
  flush,
  messageEvent,
  onlyClient,
  pending,
  select,
  setup,
} from './__tests__/fixture';

describe('notification resync fencing', () => {
  it('terminal-fences a queue-full chat without skipping its dropped revision', async () => {
    const transport = new FakeTransport();
    const { gateway, clients, store } = setup({
      transport,
      limits: { maxQueuedNotificationsPerChat: 1 },
    });
    await select(gateway, 'session-1', 'queue-select-a', 'chat-a');
    await gateway.handle(messageEvent('queue-sub-a', '/subscribe', { chatId: 'chat-a' }));
    await select(gateway, 'session-1', 'queue-select-b', 'chat-b');
    await gateway.handle(messageEvent('queue-sub-b', '/subscribe', { chatId: 'chat-b' }));
    const clientA = clients.get(feishuClientId(credential, 'chat-a'))!;
    const clientB = clients.get(feishuClientId(credential, 'chat-b'))!;
    clientA.pending.set('session-1', [pending()]);
    clientB.pending.set('session-1', [pending()]);
    transport.messages.length = 0;
    transport.holdChat = 'chat-a';

    clientA.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    clientA.emit({
      instanceId: credential.instanceId,
      revision: 12,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    clientA.emit({
      instanceId: credential.instanceId,
      revision: 13,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    clientB.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    await flush();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-b')?.revision).toBe(
      11,
    );
    expect(transport.messages.some((message) => message.chatId === 'chat-b')).toBe(true);

    transport.releaseHold?.();
    await flush();
    await flush();
    clientA.emit({
      instanceId: credential.instanceId,
      revision: 14,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-a')?.revision).toBe(
      11,
    );
    expect(
      transport.messages.filter(
        (message) => message.chatId === 'chat-a' && message.eventId.startsWith('notify-14-'),
      ),
    ).toHaveLength(0);
    expect(clientA.closed).toBe(true);
  });

  it('requires a new client replay after a same-instance protocol fault', async () => {
    const observer = { onError: vi.fn(), onDeliveryDropped: vi.fn() };
    const { gateway, clients, store, transport } = setup({ observer });
    await select(gateway);
    await gateway.handle(messageEvent('fault-subscribe', '/subscribe'));
    const oldClient = onlyClient(clients);
    oldClient.pending.set('session-1', [pending()]);
    transport.messages.length = 0;
    oldClient.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.\u0000created',
      entityId: 'pending-1',
      payload: {},
    });
    oldClient.emit({
      instanceId: credential.instanceId,
      revision: 12,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    await flush();
    expect(oldClient.closed).toBe(true);
    expect(transport.messages).toHaveLength(0);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);

    await gateway.handle(messageEvent('fault-reconnect', '/pending'));
    const replayClient = onlyClient(clients);
    expect(replayClient).not.toBe(oldClient);
    replayClient.pending.set('session-1', [pending()]);
    transport.messages.length = 0;
    replayClient.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    await flush();
    expect(transport.messages.filter((message) => message.kind === 'notification')).toHaveLength(1);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(
      11,
    );
  });

  it('terminalizes a wrong-instance client while another chat remains healthy', async () => {
    const { gateway, clients, store, transport } = setup();
    await select(gateway, 'session-1', 'instance-a', 'chat-a');
    await gateway.handle(messageEvent('instance-sub-a', '/subscribe', { chatId: 'chat-a' }));
    await select(gateway, 'session-1', 'instance-b', 'chat-b');
    await gateway.handle(messageEvent('instance-sub-b', '/subscribe', { chatId: 'chat-b' }));
    const clientA = clients.get(feishuClientId(credential, 'chat-a'))!;
    const clientB = clients.get(feishuClientId(credential, 'chat-b'))!;
    clientB.pending.set('session-1', [pending()]);
    transport.messages.length = 0;
    clientA.emit({
      instanceId: 'wrong-instance',
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    clientB.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    await flush();
    expect(clientA.closed).toBe(true);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-a')?.revision).toBe(10);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-b')?.revision).toBe(
      11,
    );
  });
});

describe('gateway shutdown barrier', () => {
  it('waits for held Core work and rejects new handles without claiming metadata', async () => {
    const { gateway, clients, store, transport } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    let release!: (value: unknown) => void;
    client.requestHook = (call) =>
      call.method === 'session.send'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    const handling = gateway.handle(messageEvent('close-held', '/send held')).catch(
      (error: unknown) => error,
    );
    await flush();
    let closed = false;
    const closing = gateway.close().finally(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    await expect(gateway.handle(messageEvent('after-close', '/sessions'))).rejects.toMatchObject({
      code: 'gateway_closed',
    });
    expect(store.getDelivery(credential.instanceId, 'after-close')).toBeNull();
    release({ messageId: 'late-message', sequence: 1, revision: 11 });
    await expect(handling).resolves.toMatchObject({ code: 'gateway_closed' });
    await closing;
    expect(transport.messages.some((message) => message.eventId === 'close-held')).toBe(false);
    const snapshot = store.exportMetadataSnapshot();
    const calls = client.calls.length;
    await flush();
    expect(store.exportMetadataSnapshot()).toBe(snapshot);
    expect(client.calls).toHaveLength(calls);
  });

  it('does not resolve close while a notification transport remains in flight', async () => {
    const transport = new FakeTransport();
    const { gateway, clients } = setup({ transport });
    await select(gateway);
    await gateway.handle(messageEvent('close-lane-sub', '/subscribe'));
    transport.messages.length = 0;
    transport.holdChat = 'chat-1';
    onlyClient(clients).emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'session.completed',
      entityId: 'session-1',
      payload: {},
    });
    await flush();
    let closed = false;
    const closing = gateway.close().finally(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    transport.releaseHold?.();
    await closing;
    const delivered = transport.messages.length;
    await flush();
    expect(transport.messages).toHaveLength(delivered);
  });
});
