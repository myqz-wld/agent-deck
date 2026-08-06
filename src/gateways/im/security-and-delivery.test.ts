import { describe, expect, it, vi } from 'vitest';
import {
  FeishuSessionConsoleGateway,
  boundedJsonText,
  canonicalJsonBytes,
  feishuClientId,
  parseFeishuCommand,
  parseFeishuInboundEvent,
  redactJson,
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

describe('strict Feishu schemas and deterministic grammar', () => {
  it('rejects unknown event fields, action fields, event kinds and commands exactly', () => {
    expect(() =>
      parseFeishuInboundEvent({ ...messageEvent('extra', '/sessions'), surprise: true }),
    ).toThrowError(/event.surprise is unknown/);
    expect(() =>
      parseFeishuInboundEvent({ ...messageEvent('kind', '/sessions'), kind: 'reaction' }),
    ).toThrowError(/Unknown Feishu event kind/);
    const binding = {
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'chat-1',
      chatType: 'p2p' as const,
      sessionId: 'session-1',
      requestId: 'pending-1',
      action: 'approve' as const,
      revision: 10,
      contentDigest: 'digest-1',
    };
    expect(() =>
      parseFeishuInboundEvent({
        schemaVersion: 1,
        kind: 'card-action',
        eventId: 'action-extra',
        appId: credential.appId,
        tenantKey: credential.tenantKey,
        openId: credential.openId,
        chatId: 'chat-1',
        chatType: 'p2p',
        occurredAt: 1,
        action: {
          name: 'pending.respond',
          ...binding,
          nonce: testNonce.issue(binding),
          extra: true,
        },
      }),
    ).toThrowError(/action.extra is unknown/);
    expect(() => parseFeishuCommand('/sessions later extra')).toThrowError(/用法/);
    expect(() => parseFeishuCommand('/does-not-exist')).toThrowError(/未知命令/);
    expect(() => parseFeishuCommand('/runtime-set 1 {"unknown":undefined}')).toThrowError(
      /有效 JSON/,
    );
  });

  it('does not silently normalize whitespace or allow control characters in commands', () => {
    expect(() => parseFeishuCommand('/select  session-1')).toThrowError(/用法/);
    expect(() => parseFeishuCommand('/select session-1 extra')).toThrowError(/用法/);
    expect(() => parseFeishuCommand('/send hello\u0000world')).toThrowError(/control/);
  });

  it('accepts only Workspace-relative create directories and an explicit first message', () => {
    expect(parseFeishuCommand(
      '/create codex-cli repo/my app -- Inspect this directory',
    )).toEqual({
      kind: 'create',
      adapterId: 'codex-cli',
      initialMessage: 'Inspect this directory',
      workingDirectory: 'repo/my app',
    });
    for (const directory of ['/etc', '../outside', 'repo/../outside', 'repo\\child']) {
      expect(() => parseFeishuCommand(
        `/create codex-cli ${directory} -- Inspect`,
      )).toThrowError(/Workspace/);
    }
    expect(() => parseFeishuCommand('/create codex-cli .')).toThrowError(/first-message/);
    expect(() => parseFeishuCommand('/projects')).toThrowError(/未知命令/);
  });

  it('bounds ingress, history/cards/output and deterministically redacts secrets', async () => {
    const { gateway, clients, transport } = setup({
      limits: {
        maxTextBytes: 64,
        maxOutputBytes: 1_024,
        maxPendingCards: 1,
        maxHistoryEntries: 1,
      },
    });
    expect(
      (await gateway.handle(messageEvent('too-long', 'x'.repeat(65)))).code,
    ).toBe('invalid_event');
    await gateway.handle(messageEvent('list', '/sessions'));
    expect(canonicalJsonBytes(transport.messages.at(-1))).toBeLessThanOrEqual(1_024);

    await select(gateway);
    onlyClient(clients).pending.set('session-1', [pending('one'), pending('two')]);
    await gateway.handle(messageEvent('pending-bounded', '/pending'));
    expect(transport.messages.at(-1)?.cards).toHaveLength(1);
    expect(canonicalJsonBytes(transport.messages.at(-1))).toBeLessThanOrEqual(1_024);

    const redacted = redactJson({
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      nested: { password: 'plain', safe: 'visible' },
    });
    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'visible' },
    });
    expect(boundedJsonText({ token: 'secret', safe: 'x'.repeat(1_000) }, 64)).not.toContain(
      'secret',
    );
  });
});

describe('callback acceptance window and transport retries', () => {
  it('does not acknowledge a mutation until Core accepts it', async () => {
    const { gateway, clients, transport } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    client.requestHook = async (call) => {
      if (call.method === 'session.send') await accepted;
      return undefined;
    };
    let settled = false;
    const result = gateway
      .handle(messageEvent('core-acceptance', '/send wait'))
      .finally(() => {
        settled = true;
      });
    await flush();
    expect(settled).toBe(false);
    expect(transport.messages.some((message) => message.eventId === 'core-acceptance')).toBe(false);
    accept();
    await expect(result).resolves.toMatchObject({ code: 'accepted' });
  });

  it('fails retryably when the injected platform window closes', async () => {
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      client.requestHook = () => new Promise(() => undefined);
      return client;
    };
    const { gateway } = setup({ clientFactory: factory, callbackWindowMs: 10 });
    await expect(gateway.handle(messageEvent('window', '/sessions'))).rejects.toMatchObject({
      code: 'platform_window_exceeded',
      retryable: true,
    });
  });

  it('retries transport delivery within a bound and preserves a stable Core key across callbacks', async () => {
    const transport = new FakeTransport();
    transport.failures = 1;
    const { gateway, clients } = setup({ transport });
    await select(gateway);
    await expect(gateway.handle(messageEvent('retry-delivery', '/send one'))).resolves.toMatchObject({
      code: 'accepted',
    });
    expect(transport.messages.some((message) => message.eventId === 'retry-delivery')).toBe(true);

    transport.failures = 2;
    const event = messageEvent('callback-retry', '/send two');
    const failure = await gateway.handle(event).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'delivery_failed', retryable: true });
    expect((failure as Error).message).not.toContain('transport secret');
    transport.failures = 0;
    await gateway.handle(event);
    const calls = onlyClient(clients).calls.filter(
      (call) =>
        call.method === 'session.send' && call.options?.idempotencyKey === 'feishu:callback-retry',
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.options?.idempotencyKey)).size).toBe(1);
  });
});

describe('subscription fanout and isolation', () => {
  it('keeps a slow chat from blocking another chat and persists independent cursors', async () => {
    const transport = new FakeTransport();
    const { gateway, clients, store } = setup({ transport });
    await select(gateway, 'session-1', 'select-a', 'chat-a');
    await gateway.handle(messageEvent('subscribe-a', '/subscribe', { chatId: 'chat-a' }));
    await select(gateway, 'session-1', 'select-b', 'chat-b');
    await gateway.handle(messageEvent('subscribe-b', '/subscribe', { chatId: 'chat-b' }));

    const clientA = clients.get(
      feishuClientId(credential, 'chat-a'),
    )!;
    const clientB = clients.get(
      feishuClientId(credential, 'chat-b'),
    )!;
    clientA.pending.set('session-1', [pending()]);
    clientB.pending.set('session-1', [pending()]);
    transport.messages.length = 0;
    transport.holdChat = 'chat-a';
    clientA.emit({
      instanceId: credential.instanceId,
      revision: 20,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: { mustNotBeQueued: 'business-body' },
    });
    clientB.emit({
      instanceId: credential.instanceId,
      revision: 20,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: { mustNotBeQueued: 'other-body' },
    });
    await flush();
    await flush();
    expect(transport.messages.some((message) => message.chatId === 'chat-b')).toBe(true);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-b')?.revision).toBe(
      20,
    );
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-a')?.revision).toBe(10);
    transport.releaseHold?.();
    await flush();
  });

  it('isolates observer exceptions and does not advance a failed notification cursor', async () => {
    const observer = {
      onError: vi.fn(() => {
        throw new Error('observer failure');
      }),
      onDeliveryDropped: vi.fn(() => {
        throw new Error('observer failure');
      }),
    };
    const transport = new FakeTransport();
    const { gateway, clients, store } = setup({ transport, observer });
    await select(gateway);
    await gateway.handle(messageEvent('subscribe', '/subscribe'));
    transport.failures = 2;
    const client = onlyClient(clients);
    client.emit({
      instanceId: credential.instanceId,
      revision: 30,
      kind: 'session.failed',
      entityId: 'session-1',
      payload: { secret: 'not-observed' },
    });
    await flush();
    await flush();
    expect(observer.onError).toHaveBeenCalled();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);
  });

  it('rechecks credential revocation before asynchronous notification delivery', async () => {
    const { gateway, clients, store, transport } = setup();
    await select(gateway);
    await gateway.handle(messageEvent('subscribe-revoked', '/subscribe'));
    transport.messages.length = 0;
    store.enroll({ ...credential, status: 'revoked' });
    onlyClient(clients).emit({
      instanceId: credential.instanceId,
      revision: 31,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    expect(transport.messages).toHaveLength(0);
  });

  it('does not notify an unsubscribed chat and still advances its replay cursor', async () => {
    const { gateway, clients, store, transport } = setup();
    await select(gateway);
    await gateway.handle(messageEvent('subscribe-on', '/subscribe'));
    await gateway.handle(messageEvent('subscribe-off', '/unsubscribe'));
    transport.messages.length = 0;
    onlyClient(clients).emit({
      instanceId: credential.instanceId,
      revision: 32,
      kind: 'session.completed',
      entityId: 'session-1',
      payload: {},
    });
    await flush();
    expect(transport.messages).toHaveLength(0);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(
      32,
    );
  });

  it('re-attaches persisted chat contexts on restart without restoring a business payload', async () => {
    const first = setup();
    await select(first.gateway);
    await first.gateway.close();
    const created: FakeCoreClient[] = [];
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      created.push(client);
      return client;
    };
    const restarted = new FeishuSessionConsoleGateway({
      appVersion: 'test',
      binding: gatewayBinding,
      store: first.store,
      clientFactory: factory,
      transport: new FakeTransport(),
      nonce: testNonce,
    });
    await restarted.start();
    expect(created).toHaveLength(1);
    expect(first.store.exportMetadataSnapshot()).not.toContain('cardBody');
    expect(first.store.exportMetadataSnapshot()).not.toContain('payload');
    await restarted.close();
  });
});
