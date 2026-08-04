import { describe, expect, it } from 'vitest';
import {
  FeishuSessionConsoleGateway,
  InMemoryFeishuGatewayStore,
  boundFeishuOutboundMessage,
  canonicalJsonBytes,
  type EnrolledFeishuCredential,
  type FeishuOutboundMessage,
  type FeishuPendingAction,
} from '.';
import {
  FakeCoreClient,
  FakeTransport,
  actionEvent,
  actionFrom,
  credential,
  gatewayBinding,
  flush,
  messageEvent,
  onlyClient,
  pending,
  select,
  session,
  setup,
  testNonce,
} from './__tests__/fixture';

function resign(
  input: FeishuPendingAction,
  action: FeishuPendingAction['action'],
  value?: FeishuPendingAction['value'],
): FeishuPendingAction {
  const changed = { ...input, action, ...(value === undefined ? {} : { value }) };
  const binding = {
    instanceId: changed.instanceId,
    credentialId: changed.credentialId,
    chatId: changed.chatId,
    sessionId: changed.sessionId,
    requestId: changed.requestId,
    revision: changed.revision,
    contentDigest: changed.contentDigest,
    action,
  };
  return { ...changed, nonce: testNonce.issue(binding) };
}

describe('whole outbound message bounds', () => {
  it('bounds reply and notification JSON without emitting blind action bindings', async () => {
    const maximumBytes = 1_200;
    const { gateway, clients, transport, store } = setup({
      limits: { maxOutputBytes: maximumBytes },
    });
    await gateway.handle(messageEvent('prime-list', '/sessions'));
    const client = onlyClient(clients);
    for (let index = 0; index < 40; index += 1) {
      const item = session(`many-${index}`);
      client.sessions.set(item.id, { ...item, title: '界'.repeat(170) });
    }
    transport.messages.length = 0;
    await gateway.handle(messageEvent('bounded-reply', '/sessions'));
    expect(canonicalJsonBytes(transport.messages.at(-1))).toBeLessThanOrEqual(maximumBytes);

    await select(gateway);
    client.pending.set('session-1', [
      { ...pending(), display: { description: 'x'.repeat(3_000) } },
    ]);
    await gateway.handle(messageEvent('bounded-subscribe', '/subscribe'));
    transport.messages.length = 0;
    client.emit({
      instanceId: credential.instanceId,
      revision: 20,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: { mustNotBeDelivered: 'business body' },
    });
    await flush();
    await flush();
    const notification = transport.messages.find((message) => message.kind === 'notification');
    expect(canonicalJsonBytes(notification)).toBeLessThanOrEqual(maximumBytes);
    expect(notification?.cards.flatMap((card) => card.buttons)).toHaveLength(0);
    expect(notification?.text).toContain('open a full client');
    expect(store.exportMetadataSnapshot()).not.toContain('business body');
  });

  it('converts oversized action cards to an explicit read-only warning or fails closed', () => {
    const action = resign(
      {
        name: 'pending.respond',
        instanceId: 'instance-1',
        credentialId: 'credential-1',
        chatId: 'chat-1',
        sessionId: 'session-1',
        requestId: 'request-1',
        revision: 10,
        contentDigest: 'digest-1',
        action: 'approve',
        nonce: '',
      },
      'approve',
    );
    const message: FeishuOutboundMessage = {
      eventId: 'event-1',
      instanceId: action.instanceId,
      credentialId: action.credentialId,
      chatId: action.chatId,
      kind: 'reply',
      text: 'x'.repeat(10_000),
      cards: [
        {
          title: 'title'.repeat(1_000),
          requestId: action.requestId,
          sessionId: action.sessionId,
          state: 'pending',
          createdAt: 1,
          expiresAt: null,
          presentationLifetimeMs: 1_800_000,
          display: { description: 'secret'.repeat(10_000) },
          buttons: [{ label: 'Approve'.repeat(100), action }],
        },
      ],
    };
    const bounded = boundFeishuOutboundMessage(message, 1_200);
    expect(canonicalJsonBytes(bounded)).toBeLessThanOrEqual(1_200);
    expect(bounded.cards.flatMap((card) => card.buttons)).toHaveLength(0);
    expect(bounded.text).toContain('open a full client');
    expect(() => boundFeishuOutboundMessage(message, 100)).toThrowError(
      expect.objectContaining({ code: 'delivery_too_large' }),
    );
  });

  it('fails closed for oversized Core ids and adapter-issued nonces', async () => {
    const first = setup();
    await select(first.gateway);
    onlyClient(first.clients).pending.set('session-1', [pending('x'.repeat(257))]);
    first.transport.messages.length = 0;
    expect((await first.gateway.handle(messageEvent('oversized-id', '/pending'))).code).toBe(
      'invalid_core_response',
    );
    expect(first.transport.messages).toHaveLength(0);

    const second = setup({
      nonce: { issue: () => 'n'.repeat(513), verify: () => true },
    });
    await select(second.gateway);
    onlyClient(second.clients).pending.set('session-1', [pending()]);
    second.transport.messages.length = 0;
    expect((await second.gateway.handle(messageEvent('oversized-nonce', '/pending'))).code).toBe(
      'invalid_event',
    );
    expect(second.transport.messages).toHaveLength(0);

    const third = setup();
    await expect(
      third.gateway.handle(
        messageEvent('oversized-display-name', '/sessions', {
          displayName: '名'.repeat(257),
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_event' });
    expect(third.transport.messages).toHaveLength(0);
  });
});

describe('Relay project isolation and Server Core path validation', () => {
  const relayCredential: EnrolledFeishuCredential = { ...credential, topology: 'relay' };

  it('never resolves or emits cwd for Relay create', async () => {
    const store = new InMemoryFeishuGatewayStore();
    store.enroll(relayCredential);
    const transport = new FakeTransport();
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
      transport,
      nonce: testNonce,
      projectAuthority: null,
    });
    const result = await gateway.handle(messageEvent('relay-create', '/create codex-cli project'));
    expect(result.code).toBe('capability_unavailable');
    expect(clients.flatMap((client) => client.calls)).not.toContainEqual(
      expect.objectContaining({ method: 'session.create' }),
    );
    expect(JSON.stringify(clients.flatMap((client) => client.calls))).not.toContain('cwd');
    expect(store.exportMetadataSnapshot()).not.toMatch(/cwd|\/worker\/workspace/);
    expect(transport.messages).toHaveLength(0);
  });

  it('rejects Relay cwd configuration and invalid Server Core paths', async () => {
    const relayStore = new InMemoryFeishuGatewayStore();
    relayStore.enroll(relayCredential);
    expect(() =>
      new FeishuSessionConsoleGateway({
        appVersion: 'test',
        binding: { ...gatewayBinding, topology: 'relay' },
        store: relayStore,
        clientFactory: (input) => new FakeCoreClient(input),
        transport: new FakeTransport(),
        nonce: testNonce,
        projectAuthority: { resolve: () => '/worker/workspace' },
      }),
    ).toThrowError(/Relay gateway configuration/);
    for (const [index, cwd] of [
      'relative/path',
      '/srv/../srv/project',
      '/srv/project\u0000hidden',
    ].entries()) {
      const invalid = setup({ projectAuthority: { resolve: () => cwd } });
      expect(
        (await invalid.gateway.handle(
          messageEvent(`invalid-authority-path-${index}`, '/create codex-cli project'),
        )).code,
      ).toBe('invalid_configuration');
    }
  });
});

describe('pending action semantics and Core output validation', () => {
  it('rejects valid-nonce action/value combinations that do not match request kind', async () => {
    const { gateway, clients, transport } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    client.pending.set('session-1', [pending()]);
    await gateway.handle(messageEvent('permission-card', '/pending'));
    const permission = actionFrom(transport.messages.at(-1)!);
    const invalidPermission = [
      { ...permission, value: { answer: 'not-allowed' } },
      resign(permission, 'submit', { answer: 'wrong-kind' }),
    ];
    for (const [index, action] of invalidPermission.entries()) {
      expect(
        (await gateway.handle(actionEvent(`bad-permission-${index}`, action))).code,
      ).toBe('invalid_pending_action');
    }

    client.pending.set('session-1', [{ ...pending('question'), kind: 'ask-user-question' }]);
    await gateway.handle(messageEvent('question-card-semantic', '/pending'));
    const question = actionFrom(transport.messages.at(-1)!);
    expect((await gateway.handle(actionEvent('question-no-value', question))).code).toBe(
      'invalid_pending_action',
    );

    client.pending.set('session-1', [{ ...pending('diff'), kind: 'diff-review' }]);
    await gateway.handle(messageEvent('diff-card', '/pending'));
    const diff = actionFrom(transport.messages.at(-1)!);
    expect(
      (await gateway.handle(actionEvent('diff-wrong-action', resign(diff, 'approve')))).code,
    ).toBe('invalid_pending_action');

    client.pending.set('session-1', [{ ...pending('exit'), kind: 'exit-plan' }]);
    await gateway.handle(messageEvent('exit-card', '/pending'));
    const exitPlan = actionFrom(transport.messages.at(-1)!);
    expect(
      (await gateway.handle(actionEvent('exit-value', { ...exitPlan, value: 'unexpected' }))).code,
    ).toBe('invalid_pending_action');
    expect(client.calls.filter((call) => call.method === 'pending.respond')).toHaveLength(0);
  });

  it('never reflects malformed Core identifiers, titles, or control text', async () => {
    const { gateway, clients, transport } = setup();
    await gateway.handle(messageEvent('core-prime', '/sessions'));
    const client = onlyClient(clients);
    client.sessions.set('bad-title', { ...session('bad-title'), title: 'unsafe\u0000title' });
    transport.messages.length = 0;
    expect((await gateway.handle(messageEvent('bad-title', '/sessions'))).code).toBe(
      'invalid_core_response',
    );
    expect(transport.messages).toHaveLength(0);

    client.sessions.set('bad-title', { ...session('bad-title'), title: 'x'.repeat(513) });
    expect((await gateway.handle(messageEvent('oversized-title', '/sessions'))).code).toBe(
      'invalid_core_response',
    );
    expect(transport.messages).toHaveLength(0);
    client.sessions.delete('bad-title');
    await select(gateway);
    client.histories.set('session-1', [
      {
        id: 'history-1',
        sessionId: 'session-1',
        sequence: 1,
        role: 'assistant',
        content: 'safe\u0000control',
        createdAt: 1,
      },
    ]);
    transport.messages.length = 0;
    expect((await gateway.handle(messageEvent('history-control', '/history'))).code).toBe(
      'invalid_core_response',
    );
    expect(transport.messages).toHaveLength(0);
  });
});
