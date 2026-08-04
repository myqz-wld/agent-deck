import { describe, expect, it } from 'vitest';
import type { FeishuAgentDeckClientFactory } from '.';
import {
  FakeCoreClient,
  FakeTransport,
  credential,
  flush,
  messageEvent,
  pending,
  select,
  session,
  setup,
} from './__tests__/fixture';

describe('stream generation and replay barriers', () => {
  it('admits synchronous subscribe replay and seeds the initial hello cursor first', async () => {
    const created: FakeCoreClient[] = [];
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      client.subscribeHook = (listener) => listener({
        instanceId: credential.instanceId,
        revision: 11,
        kind: 'session.completed',
        entityId: 'session-1',
        payload: {},
      });
      created.push(client);
      return client;
    };
    const { gateway, store } = setup({ clientFactory: factory });
    await gateway.handle(messageEvent('sync-replay', '/sessions'));
    await flush();
    await flush();
    expect(created[0]?.subscribeRevisions).toEqual([10]);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(
      11,
    );
  });

  it('holds reconnect behind retirement and rejects stale callbacks from the old epoch', async () => {
    const created: FakeCoreClient[] = [];
    let releaseClose!: () => void;
    const closeHold = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      client.sessions.set('session-1', session('session-1'));
      if (created.length === 0) client.closeHold = closeHold;
      else {
        client.revision = 11;
        (client.hello as { eventRevision: number }).eventRevision = 11;
      }
      client.pending.set('session-1', [pending()]);
      created.push(client);
      return client;
    };
    const transport = new FakeTransport();
    const { gateway, store } = setup({
      clientFactory: factory,
      transport,
      limits: { maxQueuedNotificationsPerChat: 1 },
    });
    await select(gateway);
    await gateway.handle(messageEvent('generation-subscribe', '/subscribe'));
    transport.messages.length = 0;
    transport.holdChat = 'chat-1';
    const old = created[0];
    old.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    for (const revision of [12, 13]) {
      old.emit({
        instanceId: credential.instanceId,
        revision,
        kind: 'pending.created',
        entityId: 'pending-1',
        payload: {},
      });
    }
    const reconnect = gateway.handle(messageEvent('generation-reconnect', '/pending'));
    await flush();
    await flush();
    expect(created).toHaveLength(1);
    expect(old.closed).toBe(true);

    transport.holdChat = null;
    transport.releaseHold?.();
    releaseClose();
    await reconnect;
    expect(created).toHaveLength(2);
    expect(old.closeCalls).toBe(1);
    expect(old.subscriptionCloseCalls).toBe(1);
    expect(created[1]?.subscribeRevisions).toEqual([11]);

    old.emitStale({
      instanceId: credential.instanceId,
      revision: 99,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(
      11,
    );
    expect(transport.messages.some((message) => message.eventId.startsWith('notify-99-'))).toBe(
      false,
    );
  });

  it('fences a connect racing shutdown before it can attach a lane', async () => {
    let releaseConnect!: () => void;
    const connectHold = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let client!: FakeCoreClient;
    const { gateway, transport } = setup({
      clientFactory: (input) => {
        client = new FakeCoreClient(input);
        client.connectHold = connectHold;
        return client;
      },
    });
    const handling = gateway.handle(messageEvent('connect-close-race', '/sessions')).catch(
      (error: unknown) => error,
    );
    await flush();
    let closed = false;
    const closing = gateway.close().finally(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    releaseConnect();
    await expect(handling).resolves.toMatchObject({ code: 'gateway_closed' });
    await closing;
    expect(client.listeners.size).toBe(0);
    expect(client.closeCalls).toBe(1);
    expect(transport.messages).toHaveLength(0);
  });

  it('memoizes client and subscription cleanup across retire/close races', async () => {
    let releaseClose!: () => void;
    const closeHold = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let client!: FakeCoreClient;
    const transport = new FakeTransport();
    const { gateway } = setup({
      transport,
      limits: { maxQueuedNotificationsPerChat: 1 },
      clientFactory: (input) => {
        client = new FakeCoreClient(input);
        client.sessions.set('session-1', session('session-1'));
        client.pending.set('session-1', [pending()]);
        client.closeHold = closeHold;
        return client;
      },
    });
    await select(gateway);
    await gateway.handle(messageEvent('retire-close-subscribe', '/subscribe'));
    transport.holdChat = 'chat-1';
    client.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    for (const revision of [12, 13]) {
      client.emit({
        instanceId: credential.instanceId,
        revision,
        kind: 'pending.created',
        entityId: 'pending-1',
        payload: {},
      });
    }
    const closing = gateway.close();
    transport.holdChat = null;
    transport.releaseHold?.();
    releaseClose();
    await closing;
    expect(client.closeCalls).toBe(1);
    expect(client.subscriptionCloseCalls).toBe(1);
  });
});
