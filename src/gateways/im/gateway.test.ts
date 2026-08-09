import { describe, expect, it, vi } from 'vitest';
import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import { AgentDeckClientErrorCode } from '@contracts/index';
import {
  DEFAULT_PENDING_PRESENTATION_LIFETIME_MS,
  FeishuSessionConsoleGateway,
  assertFeishuMethod,
  type FeishuAgentDeckClientFactory,
} from '.';
import {
  FakeCoreClient,
  FakeTransport,
  actionEvent,
  actionFrom,
  credential,
  gatewayBinding,
  messageEvent,
  onlyClient,
  pending,
  select,
  session,
  setup,
  testNonce,
} from './__tests__/fixture';

describe('FeishuSessionConsoleGateway identity and chat state', () => {
  it('authorizes only the exact enrolled app/tenant/open-id tuple, never display names', async () => {
    const { gateway, clients } = setup();
    const denied = await gateway.handle(
      messageEvent('identity-denied', '/sessions', {
        openId: 'open-unknown',
        displayName: 'Trusted Owner',
      }),
    );
    expect(denied).toMatchObject({ acknowledged: true, code: 'access_denied' });
    expect(clients.size).toBe(0);

    const accepted = await gateway.handle(
      messageEvent('identity-accepted', '/sessions', {
        displayName: 'Completely Different Name',
      }),
    );
    expect(accepted.code).toBe('accepted');
    expect(clients.size).toBe(1);

    const wrongTenant = await gateway.handle(
      messageEvent('wrong-tenant', '/sessions', { tenantKey: 'tenant-2' }),
    );
    expect(wrongTenant.code).toBe('access_denied');
  });

  it('keeps selected sessions, clients, and mutation keys independent per chat', async () => {
    const { gateway, clients } = setup();
    await select(gateway, 'session-1', 'select-a', 'chat-a');
    await select(gateway, 'session-2', 'select-b', 'chat-b');
    await gateway.handle(messageEvent('send-a', 'hello A', { chatId: 'chat-a' }));
    await gateway.handle(messageEvent('send-b', 'hello B', { chatId: 'chat-b' }));

    expect(clients.size).toBe(2);
    const sendCalls = [...clients.values()]
      .flatMap((client) => client.calls)
      .filter((call) => call.method === 'session.send');
    expect(sendCalls.map((call) => call.params)).toEqual(
      expect.arrayContaining([
        { sessionId: 'session-1', text: 'hello A' },
        { sessionId: 'session-2', text: 'hello B' },
      ]),
    );
    expect(sendCalls.map((call) => call.options?.idempotencyKey).sort()).toEqual([
      'feishu:send-a',
      'feishu:send-b',
    ]);
  });

  it('supports concurrent independently enrolled users without cross-credential context', async () => {
    const { gateway, clients, store } = setup();
    store.enroll({
      appId: 'app-1',
      tenantKey: 'tenant-1',
      openId: 'open-2',
      instanceId: 'instance-1',
      credentialId: 'credential-2',
      topology: 'server-core',
      status: 'active',
      authority: 'owner-equivalent',
    });
    await select(gateway, 'session-1', 'user-one', 'chat-shared');
    await gateway.handle(
      messageEvent('user-two', '/select session-2', {
        openId: 'open-2',
        chatId: 'chat-shared',
      }),
    );
    expect(clients.size).toBe(2);
    expect(store.getContext('instance-1', 'credential-1', 'chat-shared')?.activeSessionId).toBe(
      'session-1',
    );
    expect(store.getContext('instance-1', 'credential-2', 'chat-shared')?.activeSessionId).toBe(
      'session-2',
    );
    expect(() =>
      store.enroll({
        ...credential,
        openId: 'open-3',
        credentialId: 'credential-2',
      }),
    ).toThrowError(/already bound/);
  });

  it('deduplicates duplicate event ids and never replays the mutation', async () => {
    const { gateway, clients, transport } = setup();
    await select(gateway);
    const event = messageEvent('send-once', '/send immutable text');
    expect((await gateway.handle(event)).duplicate).toBe(false);
    expect((await gateway.handle(event)).duplicate).toBe(true);

    const client = onlyClient(clients);
    const sends = client.calls.filter((call) => call.method === 'session.send');
    expect(sends).toHaveLength(1);
    expect(sends[0].options?.idempotencyKey).toBe('feishu:send-once');
    expect(transport.messages.filter((message) => message.eventId === 'send-once')).toHaveLength(1);
  });

  it('rejects a replayed event id under another chat identity', async () => {
    const { gateway } = setup();
    await gateway.handle(messageEvent('collision', '/sessions', { chatId: 'chat-a' }));
    await expect(
      gateway.handle(messageEvent('collision', '/sessions', { chatId: 'chat-b' })),
    ).rejects.toMatchObject({ code: 'event_identity_mismatch' });
  });

  it('validates the Core-returned instance, credential, client and Feishu surface', async () => {
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      client.hello.access = {
        ...client.hello.access,
        accessCredentialId: 'wrong-credential',
      } as typeof client.hello.access;
      return client;
    };
    const { gateway } = setup({ clientFactory: factory });
    const result = await gateway.handle(messageEvent('bad-hello', '/sessions'));
    expect(result.code).toBe(AgentDeckClientErrorCode.AccessDenied);
  });
});

describe('Feishu session-console methods', () => {
  it('supports bounded listing, Workspace-directory creation, history and runtime controls', async () => {
    const { gateway, clients, transport } = setup({
      limits: { maxSessions: 1, maxHistoryEntries: 1 },
    });
    await gateway.handle(messageEvent('sessions', '/sessions'));
    expect(transport.messages.at(-1)?.text).toContain('/sessions session-page-1');

    await gateway.handle(messageEvent('create', '/create codex-cli . -- Inspect the repository'));
    const client = onlyClient(clients);
    const create = client.calls.find((call) => call.method === 'session.console.create');
    expect(create?.params).toEqual({
      adapterId: 'codex-cli',
      attachments: [],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Inspect the repository',
      workingDirectory: '.',
      options: sessionConsoleCreateOptionsFixture(),
    });
    expect(create?.options?.idempotencyKey).toBe('feishu:create');

    client.histories.set('session-3', [
      { id: 'h1', sessionId: 'session-3', sequence: 1, role: 'user', content: 'one', createdAt: 1 },
      { id: 'h2', sessionId: 'session-3', sequence: 2, role: 'assistant', content: 'two', createdAt: 2 },
    ]);
    await gateway.handle(messageEvent('history', '/history'));
    const historyCall = client.calls.find((call) => call.method === 'session.history');
    expect(historyCall?.params).toMatchObject({ sessionId: 'session-3', limit: 1 });

    await gateway.handle(
      messageEvent('runtime', '/runtime-set 10 {"approvalPolicy":"never"}'),
    );
    const runtime = client.calls.find((call) => call.method === 'session.runtime.update');
    expect(runtime?.options).toMatchObject({
      idempotencyKey: 'feishu:runtime',
      expectedRevision: 10,
    });
  });

  it('rejects arbitrary paths and fields outside the selected adapter ownership', async () => {
    const { gateway, clients } = setup();
    expect(
      (await gateway.handle(messageEvent('bad-directory', '/create codex-cli /etc -- Inspect'))).code,
    ).toBe('invalid_command');
    await select(gateway);
    const client = onlyClient(clients);
    client.sessions.set('session-1', session('session-1', 'codex-cli'));
    const result = await gateway.handle(
      messageEvent('bad-runtime', '/runtime-set 10 {"permissionMode":"bypassPermissions"}'),
    );
    expect(result.code).toBe('capability_unavailable');
    expect(client.calls.some((call) => call.method === 'session.runtime.update')).toBe(false);
  });

  it('enforces both the fixed method surface and negotiated capabilities', () => {
    const input = {
      instanceId: 'instance-1',
      credentialId: 'credential-1',
      clientId: 'client-1',
      topology: 'server-core' as const,
    };
    const client = new FakeCoreClient(input, []);
    expect(() => assertFeishuMethod(client.hello, 'system.health')).toThrowError(
      /outside the fixed Feishu/,
    );
    expect(() => assertFeishuMethod(client.hello, 'session.list')).toThrowError(
      /outside the fixed Feishu/,
    );
    expect(() => assertFeishuMethod(client.hello, 'session.console.list')).toThrowError(
      /does not advertise/,
    );
  });
});

describe('authoritative pending actions', () => {
  it('renders only still-pending requests with redaction and re-reads before responding', async () => {
    const { gateway, clients, transport } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    client.pending.set('session-1', [
      pending('live', 'session-1', 'pending'),
      pending('old', 'session-1', 'resolved'),
    ]);
    await gateway.handle(messageEvent('pending-list', '/pending'));
    const reply = transport.messages.at(-1);
    expect(reply?.cards).toHaveLength(1);
    expect(JSON.stringify(reply)).not.toContain('secret-value');
    expect(reply?.cards[0].display).toMatchObject({
      requestKind: 'permission',
      details: { tool: 'Bash', command: 'pnpm test' },
    });
    expect(reply?.cards[0].display).not.toHaveProperty('details.apiKey');

    const action = actionFrom(reply!);
    await gateway.handle(actionEvent('approve-live', action));
    const sequence = client.calls.slice(-2).map((call) => call.method);
    expect(sequence).toEqual(['pending.list', 'pending.respond']);
    const respond = client.calls.at(-1);
    expect(respond?.options).toMatchObject({
      idempotencyKey: 'feishu:approve-live',
      expectedRevision: expect.any(Number),
    });

    const terminal = await gateway.handle(actionEvent('approve-terminal', action));
    expect(terminal.code).toBe('already_decided');
    expect(client.calls.filter((call) => call.method === 'pending.respond')).toHaveLength(1);
  });

  it('binds cards to instance, chat, credential, session, request, displayed action and nonce', async () => {
    const { gateway, clients, transport } = setup();
    await select(gateway);
    onlyClient(clients).pending.set('session-1', [pending()]);
    await gateway.handle(messageEvent('pending-card', '/pending'));
    const action = actionFrom(transport.messages.at(-1)!);

    const mismatch = await gateway.handle(
      actionEvent('mismatch', { ...action, credentialId: 'credential-other' }),
    );
    expect(mismatch.code).toBe('access_denied');
    const nonce = await gateway.handle(
      actionEvent('nonce', { ...action, nonce: 'nonce-invalid' }),
    );
    expect(nonce.code).toBe('invalid_nonce');
    expect(onlyClient(clients).calls.some((call) => call.method === 'pending.respond')).toBe(false);
  });

  it('supports bounded ask-user values without persisting the submitted business value', async () => {
    const { gateway, clients, transport, store } = setup();
    await select(gateway);
    const request = { ...pending('question'), kind: 'ask-user-question' as const };
    onlyClient(clients).pending.set('session-1', [request]);
    await gateway.handle(messageEvent('question-card', '/pending'));
    const button = actionFrom(transport.messages.at(-1)!);
    expect(button.action).toBe('submit');
    const submitted = 'private-answer-MUST-NOT-PERSIST';
    await gateway.handle(
      actionEvent('question-answer', { ...button, value: { answer: submitted } }),
    );
    const respond = onlyClient(clients).calls.find(
      (call) =>
        call.method === 'pending.respond' &&
        (call.params as { requestId?: string }).requestId === 'question',
    );
    expect(respond?.params).toMatchObject({ value: { answer: submitted } });
    expect(store.exportMetadataSnapshot()).not.toContain(submitted);
  });

  it('uses the 30-minute presentation default or exact zero without expiring Core state locally', async () => {
    expect(DEFAULT_PENDING_PRESENTATION_LIFETIME_MS).toBe(1_800_000);
    const first = setup();
    await select(first.gateway);
    onlyClient(first.clients).pending.set('session-1', [pending()]);
    await first.gateway.handle(messageEvent('card-default', '/pending'));
    const card = first.transport.messages.at(-1)!;
    expect(card.cards[0].presentationLifetimeMs).toBe(1_800_000);
    await first.gateway.handle(actionEvent('after-display-age', actionFrom(card), { occurredAt: 3_600_001 }));
    expect(onlyClient(first.clients).calls.some((call) => call.method === 'pending.respond')).toBe(true);

    const second = setup({ pendingPresentationLifetimeMs: 0 });
    await select(second.gateway);
    onlyClient(second.clients).pending.set('session-1', [pending()]);
    await second.gateway.handle(messageEvent('card-indefinite', '/pending'));
    expect(second.transport.messages.at(-1)?.cards[0].presentationLifetimeMs).toBe(0);
  });
});

describe('delivery/restart and Relay offline behavior', () => {
  it('reuses the persisted event ledger after restart without storing the message body', async () => {
    const first = setup();
    await select(first.gateway);
    const body = 'business-body-MUST-NOT-PERSIST';
    const event = messageEvent('restart-send', body);
    await first.gateway.handle(event);
    expect(first.store.exportMetadataSnapshot()).not.toContain(body);
    await first.gateway.close();

    const transport = new FakeTransport();
    const factory = vi.fn<FeishuAgentDeckClientFactory>();
    const restarted = new FeishuSessionConsoleGateway({
      appVersion: 'test',
      binding: gatewayBinding,
      store: first.store,
      clientFactory: factory,
      transport,
      nonce: testNonce,
    });
    const duplicate = await restarted.handle(event);
    expect(duplicate).toMatchObject({ duplicate: true, code: 'deduplicated' });
    expect(factory).not.toHaveBeenCalled();
    expect(transport.messages).toHaveLength(0);
  });

  it('reports worker_offline as retryable and retries with the same idempotency key without a queue', async () => {
    let online = false;
    const { gateway, clients, transport } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    client.requestHook = (call) => {
      if (call.method !== 'session.send' || online) return undefined;
      const error = new Error('Worker offline') as Error & { code: string; retryable: boolean };
      error.code = AgentDeckClientErrorCode.WorkerOffline;
      error.retryable = true;
      throw error;
    };
    const event = messageEvent('offline-send', '/send once');
    await expect(gateway.handle(event)).rejects.toMatchObject({
      code: AgentDeckClientErrorCode.WorkerOffline,
      retryable: true,
    });
    expect(transport.messages.some((message) => message.eventId === 'offline-send')).toBe(false);
    online = true;
    await gateway.handle(event);
    const calls = client.calls.filter((call) => call.method === 'session.send');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.options?.idempotencyKey))).toEqual(
      new Set(['feishu:offline-send']),
    );
  });
});
