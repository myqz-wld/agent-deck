import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FeishuGatewayError,
  FeishuTransportNotAcceptedError,
  InMemoryFeishuGatewayStore,
  classifyGatewayError,
  feishuClientId,
  type EnrolledFeishuCredential,
  type FeishuDeliveryAttemptContext,
  type FeishuGatewayClock,
  type FeishuOutboundMessage,
  type FeishuTransportPort,
} from '.';
import {
  FakeCoreClient,
  FakeTransport,
  credential,
  flush,
  messageEvent,
  onlyClient,
  project,
  select,
  setup,
} from './__tests__/fixture';

class ManualClock implements FeishuGatewayClock {
  private time = 0;
  private readonly timers: Array<{
    at: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  now(): number {
    return this.time;
  }

  setTimer(callback: () => void, delayMs: number): { cancel(): void } {
    const timer = { at: this.time + delayMs, callback, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (const timer of this.timers) {
      if (!timer.cancelled && timer.at <= this.time) {
        timer.cancelled = true;
        timer.callback();
      }
    }
  }
}

class LateTransport implements FeishuTransportPort {
  readonly started: string[] = [];
  readonly completed: string[] = [];
  readonly contexts: FeishuDeliveryAttemptContext[] = [];
  holdEventId: string | null = null;
  private resolveHeld: (() => void) | null = null;
  private rejectHeld: ((error: Error) => void) | null = null;

  async deliver(
    message: FeishuOutboundMessage,
    context: FeishuDeliveryAttemptContext,
  ): Promise<void> {
    this.started.push(message.eventId);
    this.contexts.push(context);
    if (message.eventId === this.holdEventId) {
      await new Promise<void>((resolve, reject) => {
        this.resolveHeld = resolve;
        this.rejectHeld = reject;
      });
    }
    this.completed.push(message.eventId);
  }

  settle(outcome: 'not-accepted' | 'reject' | 'resolve'): void {
    if (outcome === 'resolve') this.resolveHeld?.();
    else if (outcome === 'not-accepted') {
      this.rejectHeld?.(new FeishuTransportNotAcceptedError());
    }
    else this.rejectHeld?.(new Error('late transport secret'));
  }
}

describe('callback deadline and delivery generation fencing', () => {
  it('does not start transport when Core resolves after the callback timeout', async () => {
    let resolveList!: (value: unknown) => void;
    const clock = new ManualClock();
    const transport = new FakeTransport();
    const factory = (input: ConstructorParameters<typeof FakeCoreClient>[0]) => {
      const client = new FakeCoreClient(input);
      client.requestHook = (call) =>
        call.method === 'session.console.list'
          ? new Promise((resolve) => {
              resolveList = resolve;
            })
          : undefined;
      return client;
    };
    const { gateway } = setup({
      clientFactory: factory,
      transport,
      callbackWindowMs: 10,
      clock,
    });
    const handling = gateway.handle(messageEvent('late-core', '/sessions'));
    await flush();
    clock.advance(10);
    await expect(handling).rejects.toMatchObject({
      code: 'platform_window_exceeded',
    });
    resolveList({
      sessions: [{
        id: 'session-1', adapterId: 'codex-cli', title: 'Session', status: 'idle',
        createdAt: 1, updatedAt: 2,
      }],
      nextCursor: null,
      total: 1,
      revision: 10,
    });
    await flush();
    await flush();
    expect(transport.attempts).toHaveLength(0);
    expect(transport.messages).toHaveLength(0);
  });

  it('does not start create after a late project resolution exhausts the callback window', async () => {
    let resolveProject!: (value: unknown) => void;
    let created!: FakeCoreClient;
    const clock = new ManualClock();
    const transport = new FakeTransport();
    const { gateway } = setup({
      clientFactory: (input) => {
        created = new FakeCoreClient(input);
        created.projects.set('project-1', project());
        created.requestHook = (call) => call.method === 'project.resolve'
          ? new Promise((resolve) => {
              resolveProject = resolve;
            })
          : undefined;
        return created;
      },
      transport,
      callbackWindowMs: 10,
      clock,
    });
    const handling = gateway.handle(messageEvent('late-project', '/create codex-cli project'));
    await flush();
    clock.advance(10);
    await expect(handling).rejects.toMatchObject({ code: 'platform_window_exceeded' });
    resolveProject({ project: project(), revision: 10 });
    await flush();
    await flush();
    expect(created.calls.some((call) => call.method === 'session.console.create')).toBe(false);
    expect(transport.attempts).toHaveLength(0);
  });

  it.each(['resolve', 'reject'] as const)(
    'fences metadata and duplicate sends when transport settles late with %s',
    async (outcome) => {
      const transport = new LateTransport();
      const clock = new ManualClock();
      const { gateway, clients, store } = setup({
        transport,
        callbackWindowMs: 10,
        clock,
      });
      await select(gateway);
      transport.holdEventId = 'late-transport';
      const event = messageEvent('late-transport', '/send once');
      const handling = gateway.handle(event);
      await flush();
      clock.advance(10);
      await expect(handling).rejects.toMatchObject({
        code: 'platform_window_exceeded',
      });
      expect(transport.started.filter((id) => id === event.eventId)).toHaveLength(1);
      expect(transport.contexts.at(-1)?.signal.aborted).toBe(true);
      expect(store.getDelivery(credential.instanceId, event.eventId)?.status).toBe('reconciling');

      await expect(gateway.handle(event)).resolves.toMatchObject({
        code: 'reconciliation_required',
      });
      expect(transport.started.filter((id) => id === event.eventId)).toHaveLength(1);
      transport.settle(outcome);
      await flush();
      await flush();
      expect(store.getDelivery(credential.instanceId, event.eventId)?.status).toBe('exhausted');
      expect(transport.started.filter((id) => id === event.eventId)).toHaveLength(1);
      const sends = onlyClient(clients).calls.filter((call) => call.method === 'session.send');
      expect(sends).toHaveLength(1);
      expect(sends[0].options?.idempotencyKey).toBe('feishu:late-transport');
    },
  );

  it('reclaims a timed-out transport that later proves it was not accepted', async () => {
    const transport = new LateTransport();
    const clock = new ManualClock();
    const { gateway, store } = setup({ transport, callbackWindowMs: 10, clock });
    await select(gateway);
    const event = messageEvent('late-definitely-not-accepted', '/send once');
    transport.holdEventId = event.eventId;
    const first = gateway.handle(event);
    await flush();
    clock.advance(10);
    await expect(first).rejects.toMatchObject({ code: 'platform_window_exceeded' });
    expect(store.getDelivery(credential.instanceId, event.eventId)?.status).toBe('reconciling');

    transport.settle('not-accepted');
    await flush();
    await flush();
    expect(store.getDelivery(credential.instanceId, event.eventId)?.status).toBe('failed');

    transport.holdEventId = null;
    await expect(gateway.handle(event)).resolves.toMatchObject({ code: 'accepted' });
    expect(transport.started.filter((id) => id === event.eventId)).toHaveLength(2);
  });

  it('retries a possibly accepted late Core mutation with the identical idempotency key', async () => {
    const clock = new ManualClock();
    const transport = new FakeTransport();
    const { gateway, clients } = setup({ transport, callbackWindowMs: 10, clock });
    await select(gateway);
    const client = onlyClient(clients);
    let resolveFirst!: (value: unknown) => void;
    let sends = 0;
    client.requestHook = (call) => {
      if (call.method !== 'session.send') return undefined;
      sends += 1;
      if (sends === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { messageId: 'message-retry', sequence: 2, revision: 12 };
    };
    const event = messageEvent('late-core-mutation', '/send exactly-once-key');
    const first = gateway.handle(event);
    await flush();
    clock.advance(10);
    await expect(first).rejects.toMatchObject({ code: 'platform_window_exceeded' });
    resolveFirst({ messageId: 'message-late', sequence: 1, revision: 11 });
    await flush();
    expect(transport.messages.some((message) => message.eventId === event.eventId)).toBe(false);
    await gateway.handle(event);
    const calls = client.calls.filter((call) => call.method === 'session.send');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.options?.idempotencyKey))).toEqual(
      new Set(['feishu:late-core-mutation']),
    );
    expect(transport.messages.filter((message) => message.eventId === event.eventId)).toHaveLength(
      1,
    );
  });

  it('does not run a queued same-chat subscription after its callback deadline', async () => {
    const clock = new ManualClock();
    const { gateway, clients } = setup({ callbackWindowMs: 10, clock });
    await select(gateway, 'session-1', 'queued-subscription-select-one');
    const client = onlyClient(clients);
    let releaseFirst!: (value: unknown) => void;
    client.requestHook = (call) =>
      call.method === 'subscription.set' &&
      (call.params as { sessionId?: unknown }).sessionId === 'session-1'
        ? new Promise((resolve) => {
            releaseFirst = resolve;
          })
        : undefined;
    const first = gateway.handle(messageEvent('queued-subscription-one', '/subscribe'));
    await flush();
    await select(gateway, 'session-2', 'queued-subscription-select-two');
    const second = gateway.handle(messageEvent('queued-subscription-two', '/subscribe'));
    await flush();
    expect(client.calls.filter((call) => call.method === 'subscription.set')).toHaveLength(1);

    clock.advance(10);
    await expect(first).rejects.toMatchObject({ code: 'platform_window_exceeded' });
    await expect(second).rejects.toMatchObject({ code: 'platform_window_exceeded' });
    releaseFirst({ subscribed: true, revision: 11 });
    await flush();
    await flush();
    expect(client.calls.filter((call) => call.method === 'subscription.set')).toHaveLength(1);
  });

  it('rejects a stale attempt finishing over a later delivery generation', () => {
    const store = new InMemoryFeishuGatewayStore();
    const input = {
      instanceId: 'instance-1',
      eventId: 'event-1',
      credentialId: 'credential-1',
      chatId: 'chat-1',
      updatedAt: 1,
    };
    const first = store.claimDelivery(input, 3);
    expect(store.finishDelivery('instance-1', 'event-1', first.record.attempts, 'failed', 2)).toBe(
      true,
    );
    const second = store.claimDelivery({ ...input, updatedAt: 3 }, 3);
    expect(second.record.attempts).toBe(2);
    expect(store.finishDelivery('instance-1', 'event-1', 1, 'sent', 4)).toBe(false);
    expect(store.finishDelivery('instance-1', 'event-1', 2, 'sent', 5)).toBe(true);
    expect(store.getDelivery('instance-1', 'event-1')).toMatchObject({
      attempts: 2,
      status: 'sent',
      updatedAt: 5,
    });
  });
});

describe('dependency error disclosure and stable client identities', () => {
  it('maps arbitrary dependency codes, messages, and controls to fixed internal_error', async () => {
    const audit: unknown[] = [];
    const { gateway, clients, transport } = setup({
      audit: { record: (entry) => audit.push(entry) },
    });
    const clientPromise = gateway.handle(messageEvent('error-prime', '/sessions'));
    await clientPromise;
    transport.messages.length = 0;
    const client = onlyClient(clients);
    client.requestHook = () => {
      const error = new Error('secret\n\u0000Bearer abcdefghijklmnopqrstuvwxyz') as Error & {
        code: string;
      };
      error.code = 'ENOENT\nsecret-code';
      throw error;
    };
    const failure = await gateway.handle(messageEvent('error-hidden', '/sessions')).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'internal_error', retryable: true });
    expect(String((failure as Error).message)).toBe('Feishu gateway dependency failed');
    expect(JSON.stringify(audit)).not.toMatch(/ENOENT|Bearer|secret-code/);
    expect(transport.messages).toHaveLength(0);

    const classified = classifyGatewayError(
      new FeishuGatewayError('control\u0000code', 'private message'),
    );
    expect(classified).toEqual({
      code: 'internal_error',
      retryable: true,
      message: 'Feishu gateway request failed: internal_error',
      currentRevision: undefined,
    });
  });

  it('uses length-prefixed UTF-8 SHA-256 with stable bounded output', () => {
    const first: EnrolledFeishuCredential = {
      ...credential,
      appId: 'ab',
      tenantKey: 'c',
      openId: '用户-😀',
    };
    const second = { ...first, appId: 'a', tenantKey: 'bc' };
    expect(feishuClientId(first, 'chat-1')).toBe(feishuClientId(first, 'chat-1'));
    expect(feishuClientId(first, 'chat-1')).not.toBe(feishuClientId(second, 'chat-1'));
    expect(feishuClientId(first, '聊天')).not.toBe(feishuClientId(first, 'chat'));

    const hash = createHash('sha256');
    for (const value of [
      first.appId,
      first.tenantKey,
      first.openId,
      first.instanceId,
      first.credentialId,
      'chat-1',
    ]) {
      const bytes = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.byteLength);
      hash.update(length);
      hash.update(bytes);
    }
    const clientId = feishuClientId(first, 'chat-1');
    expect(clientId).toBe(`feishu-${hash.digest('base64url')}`);
    expect(Buffer.byteLength(clientId, 'utf8')).toBe(50);
  });
});
