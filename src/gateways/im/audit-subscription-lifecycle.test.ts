import { describe, expect, it, vi } from 'vitest';
import {
  FeishuSessionConsoleGateway,
  type FeishuAgentDeckClientFactory,
} from '.';
import {
  FakeCoreClient,
  FakeTransport,
  credential,
  gatewayBinding,
  flush,
  messageEvent,
  onlyClient,
  pending,
  select,
  setup,
  testNonce,
} from './__tests__/fixture';

describe('subscription event identity and revision validation', () => {
  it('rejects wrong-instance, stale, malformed revision/kind/id without enqueue or cursor advance', async () => {
    const observer = { onError: vi.fn(), onDeliveryDropped: vi.fn() };
    const { gateway, clients, transport, store } = setup({ observer });
    await select(gateway);
    await gateway.handle(messageEvent('subscribe-validations', '/subscribe'));
    const client = onlyClient(clients);
    client.pending.set('session-1', [pending()]);
    transport.messages.length = 0;

    client.emit({
      instanceId: 'wrong-instance',
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    client.emit({
      instanceId: credential.instanceId,
      revision: Number.NaN,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    client.emit({
      instanceId: credential.instanceId,
      revision: 99,
      kind: 'pending.\u0000created',
      entityId: 'pending-1',
      payload: {},
    });
    client.emit({
      instanceId: credential.instanceId,
      revision: 98,
      kind: 'pending.created',
      entityId: `bad\u0000id`,
      payload: {},
    });
    await flush();
    expect(transport.messages).toHaveLength(0);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);

    client.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: { ignored: 'business' },
    });
    client.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    await flush();
    expect(transport.messages.filter((message) => message.kind === 'notification')).toHaveLength(0);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);
    expect(observer.onError).toHaveBeenCalledTimes(1);
    expect(observer.onError).toHaveBeenCalledWith({
      code: 'invalid_core_event',
      operation: 'core-event',
      retryable: true,
    });
    expect(store.exportMetadataSnapshot()).not.toContain('business');
  });

  it('stops a failed lane so later revisions cannot create a cursor gap', async () => {
    const transport = new FakeTransport();
    const { gateway, clients, store } = setup({ transport });
    await select(gateway);
    await gateway.handle(messageEvent('subscribe-lane-failure', '/subscribe'));
    transport.messages.length = 0;
    transport.failures = 2;
    const client = onlyClient(clients);
    client.emit({
      instanceId: credential.instanceId,
      revision: 20,
      kind: 'session.failed',
      entityId: 'session-1',
      payload: {},
    });
    await flush();
    await flush();
    transport.failures = 0;
    client.emit({
      instanceId: credential.instanceId,
      revision: 21,
      kind: 'session.completed',
      entityId: 'session-1',
      payload: {},
    });
    await flush();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);
    expect(transport.messages).toHaveLength(0);
  });
});

describe('subscription and lifecycle failure surfaces', () => {
  it('does not cache a client when subscription attachment throws', async () => {
    const created: FakeCoreClient[] = [];
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      client.subscribeError = new Error('subscription secret');
      created.push(client);
      return client;
    };
    const { gateway } = setup({ clientFactory: factory });
    for (const eventId of ['subscribe-throw-1', 'subscribe-throw-2']) {
      await expect(gateway.handle(messageEvent(eventId, '/sessions'))).rejects.toMatchObject({
        code: 'subscription_failed',
        retryable: true,
      });
    }
    expect(created).toHaveLength(2);
    expect(created.every((client) => client.closed)).toBe(true);
    expect(created.every((client) => client.calls.length === 0)).toBe(true);
  });

  it('aggregates restart attachment failures after attempting every persisted chat', async () => {
    const first = setup();
    await select(first.gateway, 'session-1', 'restart-a', 'chat-a');
    await select(first.gateway, 'session-1', 'restart-b', 'chat-b');
    await first.gateway.close();

    const created: FakeCoreClient[] = [];
    const observer = { onError: vi.fn(), onDeliveryDropped: vi.fn() };
    const restarted = new FeishuSessionConsoleGateway({
      appVersion: 'test',
      binding: gatewayBinding,
      store: first.store,
      clientFactory: (input) => {
        const client = new FakeCoreClient(input);
        client.subscribeError = new Error('restart attachment secret');
        created.push(client);
        return client;
      },
      transport: new FakeTransport(),
      nonce: testNonce,
      projectAuthority: null,
      observer,
    });
    const failure = await restarted.start().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'lifecycle_failed', retryable: true });
    expect((failure as Error).message).toBe('Feishu gateway start failed');
    expect(created).toHaveLength(2);
    expect(created.every((client) => client.closed)).toBe(true);
    expect(observer.onError).toHaveBeenCalledWith({
      code: 'lifecycle_failed',
      operation: 'start',
      retryable: true,
    });
  });

  it('attempts every subscription/client cleanup and rejects with one deterministic aggregate', async () => {
    const { gateway, clients } = setup();
    await select(gateway, 'session-1', 'close-a', 'chat-a');
    await select(gateway, 'session-1', 'close-b', 'chat-b');
    const connected = [...clients.values()];
    connected[0].subscriptionCloseError = new Error('subscription close secret');
    connected[0].closeError = new Error('client close secret');
    connected[1].closeError = new Error('second close secret');
    const failure = await gateway.close().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'lifecycle_failed', retryable: true });
    expect((failure as Error).message).toBe('Feishu gateway close failed');
    expect(connected.every((client) => client.closed)).toBe(true);
    expect(connected.every((client) => client.listeners.size === 0)).toBe(true);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(JSON.stringify((failure as AggregateError).errors)).not.toMatch(/secret/);
  });

  it('rejects a malformed initial Core revision and closes the partial client', async () => {
    const created: FakeCoreClient[] = [];
    const { gateway } = setup({
      clientFactory: (input) => {
        const client = new FakeCoreClient(input);
        (client.hello as { eventRevision: number }).eventRevision = Number.NaN;
        created.push(client);
        return client;
      },
    });
    expect((await gateway.handle(messageEvent('bad-hello-revision', '/sessions'))).code).toBe(
      'invalid_core_response',
    );
    expect(created[0]?.closed).toBe(true);
  });
});
