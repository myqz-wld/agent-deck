import { describe, expect, it, vi } from 'vitest';

import {
  AgentDeckCapability,
  isJsonObject,
  type JsonValue,
} from '@contracts/index';
import { encodeJsonFrame } from '@protocol/frame';

import {
  FakeSpawnHarness,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from './__tests__/fake-process';
import { combine, completeConnect, hasMessageType, makeClient } from './__tests__/client-fixture';

describe('SshAgentDeckClient protocol transport', () => {
  it('decodes fragmented/coalesced frames and correlates out-of-order responses', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness);
    const connected = client.connect(makeClientHello('desktop-a'));
    const process = harness.latest;
    const helloFrame = encodeJsonFrame({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: makeHostHello('desktop-a'),
    } as unknown as JsonValue);
    process.emitBytes(helloFrame.subarray(0, 3));
    process.emitBytes(helloFrame.subarray(3));
    await connected;

    const first = client.request('system.health', {}, { requestId: 'request-1' });
    const second = client.request('session.list', {}, { requestId: 'request-2' });
    expect(process.takeWrittenMessages().filter((message) => hasMessageType(message, 'request'))).toHaveLength(
      2,
    );
    process.emitBytes(
      combine(
        encodeJsonFrame({
          type: 'result',
          requestId: 'request-2',
          result: { sessions: [], revision: 8 },
          revision: 8,
        }),
        encodeJsonFrame({
          type: 'result',
          requestId: 'request-1',
          result: { ok: true, revision: 7 },
          revision: 7,
        }),
      ),
    );
    await expect(first).resolves.toEqual({ ok: true, revision: 7 });
    await expect(second).resolves.toEqual({ sessions: [], revision: 8 });
    await client.close();
  });

  it('adds stable mutation metadata and emits cancel for an aborted request', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'metadata', 'full', { now: () => 1_000 });
    const process = await completeConnect(client, harness, 'desktop-metadata');

    await expect(
      client.request('pending.respond', {
        sessionId: 'session-a',
        requestId: 'pending-a',
        action: 'approve',
      }),
    ).rejects.toThrow('requires expectedRevision');

    const controller = new AbortController();
    const result = client.requestCancellable(
      'pending.respond',
      {
        sessionId: 'session-a',
        requestId: 'pending-a',
        action: 'approve',
      },
      {
        requestId: 'mutation-a',
        expectedRevision: 4,
        deadlineMs: 5_000,
        signal: controller.signal,
      },
    );
    const request = process
      .takeWrittenMessages()
      .find((message) => hasMessageType(message, 'request'));
    expect(request).toMatchObject({
      requestId: 'mutation-a',
      idempotencyKey: 'desktop-metadata:mutation-a',
      expectedRevision: 4,
      deadlineAt: 6_000,
    });

    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(process.takeWrittenMessages()).toContainEqual(
      expect.objectContaining({ type: 'cancel', targetRequestId: 'mutation-a' }),
    );
    process.emitMessage({
      type: 'result',
      requestId: 'mutation-a',
      result: { status: 'resolved', revision: 5 },
      revision: 5,
    });
    expect(client.connectionState.status).toBe('connected');
    await client.close();
  });

  it('turns a local deadline into a correlated cancel and typed deadline error', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'deadline', 'full', { now: () => 1_000 });
      const process = await completeConnect(client, harness, 'desktop-deadline');
      const result = client.request('system.health', {}, {
        requestId: 'deadline-request',
        deadlineMs: 5,
      });
      const outcome = result.catch((error: unknown) => error);
      process.takeWrittenMessages();
      await vi.advanceTimersByTimeAsync(5);
      await expect(outcome).resolves.toMatchObject({ code: 'deadline_exceeded' });
      expect(process.takeWrittenMessages()).toContainEqual(
        expect.objectContaining({ type: 'cancel', targetRequestId: 'deadline-request' }),
      );
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects methods whose negotiated capability is absent before writing them', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'capabilities');
    const process = await completeConnect(client, harness, 'desktop-capabilities', 'full', {
      capabilities: [AgentDeckCapability.SessionsRead],
    });
    process.takeWrittenMessages();
    await expect(
      client.request('session.create', {
        adapterId: 'codex-cli',
        cwd: '/remote/project',
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(process.takeWrittenMessages()).toEqual([]);
    await client.close();
  });

  it('queues above the negotiated in-flight limit and bounds both request and write queues', async () => {
    const inFlightHarness = new FakeSpawnHarness();
    const inFlightClient = makeClient(inFlightHarness, 'in-flight', 'full', {
      bounds: { maxInFlightRequests: 1, maxQueuedRequests: 2 },
    });
    const inFlightProcess = await completeConnect(
      inFlightClient,
      inFlightHarness,
      'desktop-in-flight',
    );
    inFlightProcess.takeWrittenMessages();
    const first = inFlightClient.request('system.health', {}, { requestId: 'one' });
    const second = inFlightClient.request('session.list', {}, { requestId: 'two' });
    const firstOutcome = first.catch((error: unknown) => error);
    const secondOutcome = second.catch((error: unknown) => error);
    expect(inFlightProcess.takeWrittenMessages()).toEqual([
      expect.objectContaining({ type: 'request', requestId: 'one' }),
    ]);
    await expect(
      inFlightClient.request('session.get', { sessionId: 's' }, { requestId: 'three' }),
    ).rejects.toMatchObject({ code: 'in_flight_limit' });
    inFlightProcess.emitMessage({
      type: 'result', requestId: 'one', result: { ok: true, revision: 1 }, revision: 1,
    });
    await expect(firstOutcome).resolves.toEqual({ ok: true, revision: 1 });
    expect(inFlightProcess.takeWrittenMessages()).toEqual([
      expect.objectContaining({ type: 'request', requestId: 'two' }),
    ]);
    inFlightProcess.emitMessage({
      type: 'result', requestId: 'two', result: { sessions: [], revision: 1 }, revision: 1,
    });
    await expect(secondOutcome).resolves.toEqual({ sessions: [], revision: 1 });
    await inFlightClient.close();

    const queueHarness = new FakeSpawnHarness();
    const queueClient = makeClient(queueHarness, 'write-queue', 'full', {
      bounds: {
        maxInFlightRequests: 8,
        maxQueuedWriteBytes: 1024 * 1024,
        maxQueuedWriteFrames: 3,
      },
    });
    const process = await completeConnect(queueClient, queueHarness, 'desktop-queue');
    process.stdin.blocked = true;
    const one = queueClient.request('system.health', {}, { requestId: 'queued-1' });
    const two = queueClient.request('session.list', {}, { requestId: 'queued-2' });
    void one.catch(() => undefined);
    void two.catch(() => undefined);
    await expect(
      queueClient.request('session.get', { sessionId: 's' }, { requestId: 'queued-3' }),
    ).rejects.toMatchObject({ code: 'write_queue_limit' });
    await queueClient.close();
  });

  it('reconnects with backoff, resubscribes from its cursor, and resends correlation metadata', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'reconnect', 'full', {
        reconnect: { initialDelayMs: 10, maxDelayMs: 100, multiplier: 2, maxAttempts: 2 },
      });
      const firstProcess = await completeConnect(client, harness, 'desktop-reconnect');
      client.subscribe(0, () => undefined);
      firstProcess.takeWrittenMessages();
      firstProcess.emitMessage({
        type: 'event',
        instanceId: 'server-a',
        revision: 1,
        kind: 'session.updated',
        entityId: 's1',
        payload: {},
      });
      const result = client.request('system.health', {}, { requestId: 'retry-me' });
      firstProcess.takeWrittenMessages();
      firstProcess.exit(255);
      expect(client.connectionState.status).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(10);
      expect(harness.calls).toHaveLength(2);
      const secondProcess = harness.latest;
      const secondHello = secondProcess
        .takeWrittenMessages()
        .find((message) => hasMessageType(message, 'hello'));
      expect(secondHello).toEqual(
        expect.objectContaining({ hello: expect.objectContaining({ lastEventRevision: 1 }) }),
      );
      if (!isJsonObject(secondHello) || typeof secondHello.requestId !== 'string') {
        throw new Error('Missing reconnect hello');
      }
      const secondHelloId = secondHello.requestId;
      secondProcess.emitMessage({
        type: 'hello-result',
        requestId: secondHelloId,
        hello: makeHostHello('desktop-reconnect', 'full', { eventRevision: 1 }),
      } as unknown as JsonValue);
      const replayed = secondProcess.takeWrittenMessages();
      expect(replayed).toContainEqual(
        expect.objectContaining({ type: 'subscribe', afterRevision: 1 }),
      );
      expect(replayed).toContainEqual(
        expect.objectContaining({ type: 'request', requestId: 'retry-me' }),
      );
      secondProcess.emitMessage({
        type: 'result',
        requestId: 'retry-me',
        result: { ok: true, revision: 2 },
        revision: 2,
      });
      await expect(result).resolves.toEqual({ ok: true, revision: 2 });
      firstProcess.emitMessage({
        type: 'result',
        requestId: 'unknown-from-old-generation',
        result: null,
        revision: 2,
      });
      expect(client.connectionState.status).toBe('connected');
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-admits retained requests when a reconnect negotiates a lower concurrency limit', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'lower-limit', 'full', {
        bounds: { maxInFlightRequests: 3, maxQueuedRequests: 8 },
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
      });
      const firstProcess = await completeConnect(client, harness, 'desktop-lower-limit');
      firstProcess.takeWrittenMessages();
      const results = [
        client.request('system.health', {}, { requestId: 'retained-one' }),
        client.request('session.list', {}, { requestId: 'retained-two' }),
        client.request('session.get', { sessionId: 's' }, { requestId: 'retained-three' }),
      ];
      firstProcess.takeWrittenMessages();
      firstProcess.exit(255);
      await vi.advanceTimersByTimeAsync(10);
      const secondProcess = harness.latest;
      const helloMessage = secondProcess.takeWrittenMessages()
        .find((message) => hasMessageType(message, 'hello'));
      if (!isJsonObject(helloMessage) || typeof helloMessage.requestId !== 'string') {
        throw new Error('Missing reconnect hello');
      }
      secondProcess.emitMessage({
        type: 'hello-result',
        requestId: helloMessage.requestId,
        hello: makeHostHello('desktop-lower-limit', 'full', {
          limits: {
            maxFrameBytes: 1024 * 1024,
            maxBlobBytes: 4 * 1024 * 1024,
            maxConcurrentRequests: 1,
            maxQueuedEvents: 128,
          },
        }),
      } as unknown as JsonValue);
      expect(secondProcess.takeWrittenMessages()).toEqual([
        expect.objectContaining({ type: 'request', requestId: 'retained-one' }),
      ]);
      secondProcess.emitMessage({
        type: 'result', requestId: 'retained-one', result: { ok: true }, revision: 1,
      });
      expect(secondProcess.takeWrittenMessages()).toEqual([
        expect.objectContaining({ type: 'request', requestId: 'retained-two' }),
      ]);
      secondProcess.emitMessage({
        type: 'result', requestId: 'retained-two', result: { sessions: [] }, revision: 1,
      });
      expect(secondProcess.takeWrittenMessages()).toEqual([
        expect.objectContaining({ type: 'request', requestId: 'retained-three' }),
      ]);
      secondProcess.emitMessage({
        type: 'result', requestId: 'retained-three', result: null, revision: 1,
      });
      await expect(Promise.all(results)).resolves.toEqual([
        { ok: true }, { sessions: [] }, null,
      ]);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps request maps and revision cursors independent across two clients', async () => {
    const firstHarness = new FakeSpawnHarness();
    const secondHarness = new FakeSpawnHarness();
    const first = makeClient(firstHarness, 'first');
    const second = makeClient(secondHarness, 'second');
    const firstProcess = await completeConnect(first, firstHarness, 'desktop-first');
    const secondProcess = await completeConnect(second, secondHarness, 'desktop-second');
    const firstSubscription = first.subscribe(0, () => undefined);
    second.subscribe(0, () => undefined);
    firstProcess.takeWrittenMessages();
    secondProcess.takeWrittenMessages();

    const firstResult = first.request('system.health', {}, { requestId: 'same-id' });
    const secondResult = second.request('system.health', {}, { requestId: 'same-id' });
    firstProcess.emitMessage({
      type: 'result',
      requestId: 'same-id',
      result: { ok: true, revision: 1 },
      revision: 1,
    });
    secondProcess.emitMessage({
      type: 'result',
      requestId: 'same-id',
      result: { ok: true, revision: 9 },
      revision: 9,
    });
    await expect(firstResult).resolves.toMatchObject({ revision: 1 });
    await expect(secondResult).resolves.toMatchObject({ revision: 9 });

    firstProcess.emitMessage({
      type: 'event',
      instanceId: 'server-a',
      revision: 1,
      kind: 'session.updated',
      entityId: null,
      payload: {},
    });
    expect(first.lastEventRevision).toBe(1);
    expect(second.lastEventRevision).toBe(0);
    firstSubscription.close();
    expect(() => first.subscribe(0, () => undefined)).toThrowError('share its event cursor');
    await Promise.all([first.close(), second.close()]);
  });

});
