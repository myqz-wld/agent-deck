import { describe, expect, it } from 'vitest';
import {
  FeishuSessionConsoleGateway,
  InMemoryFeishuGatewayStore,
  type EnrolledFeishuCredential,
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
  session,
  setup,
  testNonce,
} from './__tests__/fixture';

describe('bounded Core response processing', () => {
  it('rejects oversized session and pending arrays before output or context selection', async () => {
    const sessions = setup({ limits: { maxSessionResults: 2 } });
    await sessions.gateway.handle(messageEvent('session-bound-prime', '/sessions'));
    onlyClient(sessions.clients).sessions.set('session-3', session('session-3'));
    sessions.transport.messages.length = 0;
    expect((await sessions.gateway.handle(messageEvent('session-array-huge', '/sessions'))).code).toBe(
      'invalid_core_response',
    );
    expect(sessions.transport.messages).toHaveLength(0);

    const requests = setup({ limits: { maxPendingResults: 1 } });
    await requests.gateway.handle(messageEvent('pending-bound-prime', '/sessions'));
    onlyClient(requests.clients).pending.set('session-1', [pending('one'), pending('two')]);
    requests.transport.messages.length = 0;
    expect(
      (await requests.gateway.handle(messageEvent('pending-array-huge', '/select session-1'))).code,
    ).toBe('invalid_core_response');
    expect(
      requests.store.getContext(credential.instanceId, credential.credentialId, 'chat-1')
        ?.activeSessionId,
    ).toBeNull();
    expect(requests.transport.messages).toHaveLength(0);

    const cumulative = setup({
      limits: { maxCoreResponseBytes: 100, maxCoreFieldBytes: 256 },
    });
    expect(
      (await cumulative.gateway.handle(messageEvent('session-cumulative-bytes', '/sessions'))).code,
    ).toBe('invalid_core_response');
    expect(cumulative.transport.messages).toHaveLength(0);
  });

  it('rejects deep/oversized history, display, questionIds, and runtime JSON', async () => {
    const { gateway, clients, transport } = setup({
      limits: { maxCoreJsonDepth: 4, maxCoreFieldBytes: 256 },
    });
    await select(gateway);
    const client = onlyClient(clients);
    let deep: unknown = 'leaf';
    for (let index = 0; index < 8; index += 1) deep = { nested: deep };
    client.histories.set('session-1', [
      {
        id: 'history-deep',
        sessionId: 'session-1',
        sequence: 1,
        role: 'assistant',
        content: deep as never,
        createdAt: 1,
      },
    ]);
    transport.messages.length = 0;
    expect((await gateway.handle(messageEvent('history-deep', '/history'))).code).toBe(
      'invalid_core_response',
    );

    client.pending.set('session-1', [
      { ...pending(), display: { command: 'x'.repeat(257) } },
    ]);
    expect((await gateway.handle(messageEvent('display-oversized', '/pending'))).code).toBe(
      'invalid_core_response',
    );
    client.pending.set('session-1', [
      {
        ...pending('questions'),
        kind: 'ask-user-question',
        display: { questionIds: Array.from({ length: 33 }, (_, index) => `q-${index}`) },
      },
    ]);
    expect((await gateway.handle(messageEvent('questions-oversized', '/pending'))).code).toBe(
      'invalid_core_response',
    );
    client.runtime.set('session-1', {
      adapterId: 'codex-cli',
      values: { approvalPolicy: 'x'.repeat(257) },
      revision: 10,
    });
    expect((await gateway.handle(messageEvent('runtime-oversized', '/runtime'))).code).toBe(
      'invalid_core_response',
    );
    expect(transport.messages).toHaveLength(0);
  });
});

describe('pinned instance/topology and Relay cwd-free projection', () => {
  it('rejects mixed active credentials at construction and dynamic drift at start', async () => {
    const other: EnrolledFeishuCredential = {
      ...credential,
      appId: 'app-2',
      openId: 'open-2',
      instanceId: 'instance-2',
      credentialId: 'credential-2',
      topology: 'relay',
    };
    const store = new InMemoryFeishuGatewayStore();
    store.enroll(credential);
    store.enroll(other);
    expect(() =>
      new FeishuSessionConsoleGateway({
        appVersion: 'test',
        binding: gatewayBinding,
        store,
        clientFactory: (input) => new FakeCoreClient(input),
        transport: new FakeTransport(),
        nonce: testNonce,
        projectAuthority: null,
      }),
    ).toThrowError(/pinned gateway/);

    const dynamic = setup();
    dynamic.store.enroll(other);
    expect(
      (await dynamic.gateway.handle(
        messageEvent('binding-handle-drift', '/sessions', {
          appId: other.appId,
          openId: other.openId,
        }),
      )).code,
    ).toBe('access_denied');
    expect(
      dynamic.store.getContext(other.instanceId, other.credentialId, 'chat-1'),
    ).toBeNull();
    await expect(dynamic.gateway.start()).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
  });

  it('fails Relay session list/get/runtime-update before consuming a cwd-bearing DTO', async () => {
    const relayCredential: EnrolledFeishuCredential = { ...credential, topology: 'relay' };
    const store = new InMemoryFeishuGatewayStore();
    store.enroll(relayCredential);
    store.putContext({
      instanceId: relayCredential.instanceId,
      credentialId: relayCredential.credentialId,
      chatId: 'chat-1',
      openId: relayCredential.openId,
      activeSessionId: 'session-1',
      updatedAt: 1,
    });
    const clients: FakeCoreClient[] = [];
    const gateway = new FeishuSessionConsoleGateway({
      appVersion: 'test',
      binding: { ...gatewayBinding, topology: 'relay' },
      store,
      clientFactory: (input) => {
        const client = new FakeCoreClient(input);
        clients.push(client);
        return client;
      },
      transport: new FakeTransport(),
      nonce: testNonce,
      projectAuthority: null,
    });
    expect((await gateway.handle(messageEvent('relay-list', '/sessions'))).code).toBe(
      'capability_unavailable',
    );
    expect((await gateway.handle(messageEvent('relay-select', '/select session-1'))).code).toBe(
      'capability_unavailable',
    );
    expect(
      (await gateway.handle(
        messageEvent('relay-runtime', '/runtime-set 10 {"approvalPolicy":"never"}'),
      )).code,
    ).toBe('capability_unavailable');
    expect(clients.flatMap((client) => client.calls)).toHaveLength(0);
  });
});

describe('revocation, subscription fanout, and runtime value domains', () => {
  it('rechecks revocation after held Core work and retires the client before transport', async () => {
    const { gateway, clients, store, transport } = setup();
    await gateway.handle(messageEvent('revocation-prime', '/sessions'));
    const client = onlyClient(clients);
    let release!: (value: unknown) => void;
    client.requestHook = (call) =>
      call.method === 'session.list'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    transport.messages.length = 0;
    const handling = gateway.handle(messageEvent('revoked-in-flight', '/sessions'));
    await flush();
    store.enroll({ ...credential, status: 'revoked' });
    release({ sessions: [session('session-1')], revision: 10 });
    await expect(handling).resolves.toMatchObject({ code: 'revoked' });
    expect(transport.messages).toHaveLength(0);
    expect(client.closed).toBe(true);
  });

  it('retires a revoked notification without waiting on its own running lane', async () => {
    const { gateway, clients, store, transport } = setup();
    await select(gateway);
    await gateway.handle(messageEvent('notification-revocation-subscribe', '/subscribe'));
    const client = onlyClient(clients);
    client.pending.set('session-1', [pending()]);
    transport.messages.length = 0;
    let release!: (value: unknown) => void;
    client.requestHook = (call) => call.method === 'pending.list'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
    client.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    store.enroll({ ...credential, status: 'revoked' });
    release({ requests: [pending()], revision: 11 });
    await flush();
    await flush();
    expect(client.closed).toBe(true);
    expect(transport.messages).toHaveLength(0);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);
  });

  it('bounds inactive and active subscription metadata together', async () => {
    const bounded = setup({ limits: { maxSubscriptionsPerChat: 1 } });
    await select(bounded.gateway);
    bounded.store.putSubscription({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'chat-1',
      sessionId: 'session-2',
      status: 'inactive',
      updatedAt: 1,
    });
    const client = onlyClient(bounded.clients);
    const before = client.calls.filter((call) => call.method === 'subscription.set').length;
    expect((await bounded.gateway.handle(
      messageEvent('subscribe-total-limit', '/subscribe'),
    )).code).toBe('subscription_limit_exceeded');
    expect(client.calls.filter((call) => call.method === 'subscription.set')).toHaveLength(before);
  });

  it('serializes same-chat subscription admission through Core and metadata commit', async () => {
    const bounded = setup({ limits: { maxSubscriptionsPerChat: 1 } });
    await select(bounded.gateway, 'session-1', 'subscription-race-select-one');
    const client = onlyClient(bounded.clients);
    let releaseFirst!: (value: unknown) => void;
    client.requestHook = (call) =>
      call.method === 'subscription.set' &&
      (call.params as { sessionId?: unknown }).sessionId === 'session-1'
        ? new Promise((resolve) => {
            releaseFirst = resolve;
          })
        : undefined;
    const first = bounded.gateway.handle(
      messageEvent('subscription-race-one', '/subscribe'),
    );
    await flush();
    await select(bounded.gateway, 'session-2', 'subscription-race-select-two');
    const second = bounded.gateway.handle(
      messageEvent('subscription-race-two', '/subscribe'),
    );
    await flush();
    expect(client.calls.filter((call) => call.method === 'subscription.set')).toHaveLength(1);

    releaseFirst({ subscribed: true, revision: 11 });
    await expect(first).resolves.toMatchObject({ code: 'accepted' });
    await expect(second).resolves.toMatchObject({ code: 'subscription_limit_exceeded' });
    expect(client.calls.filter((call) => call.method === 'subscription.set')).toHaveLength(1);
  });

  it('fences oversized persisted subscription fanout before any Core request', async () => {
    const { gateway, clients, store, transport } = setup({
      limits: { maxSubscriptionsPerChat: 1, maxNotificationCoreRequests: 1 },
    });
    await select(gateway);
    store.putSubscription({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'chat-1',
      sessionId: 'session-1',
      status: 'active',
      updatedAt: 1,
    });
    store.putSubscription({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'chat-1',
      sessionId: 'session-2',
      status: 'active',
      updatedAt: 1,
    });
    const client = onlyClient(clients);
    const pendingCalls = client.calls.filter((call) => call.method === 'pending.list').length;
    transport.messages.length = 0;
    client.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    await flush();
    expect(client.calls.filter((call) => call.method === 'pending.list')).toHaveLength(pendingCalls);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);
    expect(transport.messages).toHaveLength(0);

    const bounded = setup({ limits: { maxSubscriptionsPerChat: 1 } });
    await select(bounded.gateway);
    bounded.store.putSubscription({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'chat-1',
      sessionId: 'session-2',
      status: 'active',
      updatedAt: 1,
    });
    expect((await bounded.gateway.handle(messageEvent('subscribe-over-limit', '/subscribe'))).code).toBe(
      'subscription_limit_exceeded',
    );
    expect(
      onlyClient(bounded.clients).calls.filter((call) => call.method === 'subscription.set'),
    ).toHaveLength(0);
  });

  it('rejects adapter-owned fields whose values are outside exact runtime domains', async () => {
    const { gateway, clients } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    const invalid = [
      '/runtime-set 10 {"approvalPolicy":{"unsafe":true}}',
      '/runtime-set 10 {"codexSandbox":"strict"}',
    ];
    for (const [index, command] of invalid.entries()) {
      expect((await gateway.handle(messageEvent(`codex-value-${index}`, command))).code).toBe(
        'invalid_command',
      );
    }
    await select(gateway, 'session-2', 'claude-runtime-select');
    expect(
      (await gateway.handle(
        messageEvent('claude-permission-value', '/runtime-set 10 {"permissionMode":"dontAsk"}'),
      )).code,
    ).toBe('invalid_command');
    client.sessions.set('session-3', session('session-3', 'grok-build'));
    await select(gateway, 'session-3', 'grok-runtime-select');
    expect(
      (await gateway.handle(
        messageEvent('grok-session-value', '/runtime-set 10 {"sessionMode":["plan"]}'),
      )).code,
    ).toBe('invalid_command');
    expect(
      (await gateway.handle(
        messageEvent('grok-sandbox-value', '/runtime-set 10 {"grokSandbox":"bad\\nprofile"}'),
      )).code,
    ).toBe('invalid_command');
    expect(client.calls.filter((call) => call.method === 'session.runtime.update')).toHaveLength(0);
  });
});
