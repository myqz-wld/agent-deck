import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@contracts/index';

import { MAX_NODE_TIMER_DELAY_MS, SSH_TEXT_LIMITS } from './limits';
import { SshAgentDeckClient } from './client';
import {
  completeConnect,
  hasMessageType,
  makeClient,
  profile,
} from './__tests__/client-fixture';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from './__tests__/fake-process';

describe('SshAgentDeckClient terminal admission and bounds', () => {
  it('writes a request admitted by the connected observer only once', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'connected-observer');
    let outcome: Promise<JsonValue> | null = null;
    const subscription = client.onConnectionState((state) => {
      if (state.status === 'connected' && outcome === null) {
        outcome = client.request('system.health', {}, { requestId: 'first-after-connected' });
      }
    });
    const connected = client.connect(makeClientHello('desktop-connected-observer'));
    const process = harness.latest;
    process.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: makeHostHello('desktop-connected-observer'),
    } as unknown as JsonValue);
    await connected;

    const requests = process.takeWrittenMessages().filter((message) =>
      hasMessageType(message, 'request') && message.requestId === 'first-after-connected',
    );
    try {
      expect(requests).toHaveLength(1);
    } finally {
      process.emitMessage({
        type: 'result',
        requestId: 'first-after-connected',
        result: { ok: true },
        revision: 0,
      });
      await outcome;
      subscription.close();
      await client.close();
    }
  });

  it('writes a request admitted by a reconnect observer only once', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'reconnected-observer', 'full', {
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
      });
      const firstProcess = await completeConnect(
        client,
        harness,
        'desktop-reconnected-observer',
      );
      firstProcess.takeWrittenMessages();
      let outcome: Promise<JsonValue> | null = null;
      const subscription = client.onConnectionState((state) => {
        if (state.status === 'connected' && harness.calls.length === 2 && outcome === null) {
          outcome = client.request('system.health', {}, { requestId: 'first-after-reconnect' });
        }
      });

      firstProcess.exit(255);
      await vi.advanceTimersByTimeAsync(10);
      const secondProcess = harness.latest;
      secondProcess.emitMessage({
        type: 'hello-result',
        requestId: helloRequestId(secondProcess),
        hello: makeHostHello('desktop-reconnected-observer'),
      } as unknown as JsonValue);
      const requests = secondProcess.takeWrittenMessages().filter((message) =>
        hasMessageType(message, 'request') && message.requestId === 'first-after-reconnect',
      );
      try {
        expect(requests).toHaveLength(1);
      } finally {
        secondProcess.emitMessage({
          type: 'result',
          requestId: 'first-after-reconnect',
          result: { ok: true },
          revision: 0,
        });
        await outcome;
        subscription.close();
        await client.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits during active reconnect but rejects promptly after retry exhaustion', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'exhaustion', 'full', {
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
      });
      const firstProcess = await completeConnect(client, harness, 'desktop-exhaustion');
      const beforeDisconnect = client.request('system.health', {}, { requestId: 'before-drop' });
      const beforeOutcome = beforeDisconnect.catch((error: unknown) => error);
      firstProcess.exit(255);
      const duringReconnect = client.request('session.list', {}, { requestId: 'during-reconnect' });
      const duringOutcome = duringReconnect.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);
      harness.latest.exit(255);
      await expect(beforeOutcome).resolves.toMatchObject({ code: 'connection_failed' });
      await expect(duringOutcome).resolves.toMatchObject({ code: 'connection_failed' });
      expect(client.connectionState.status).toBe('offline');
      await expect(
        client.request('system.health', {}, { requestId: 'after-exhaustion' }),
      ).rejects.toMatchObject({ code: 'not_connected' });
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects admission after an event replay gap becomes terminal', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'event-gap');
    const process = await completeConnect(client, harness, 'desktop-event-gap');
    client.subscribe(0, () => undefined);
    process.emitMessage({
      type: 'event',
      instanceId: 'server-a',
      revision: 2,
      kind: 'session.updated',
      entityId: null,
      payload: {},
    });
    expect(client.connectionState).toMatchObject({ status: 'offline', errorCode: 'replay_gap' });
    await expect(
      client.request('system.health', {}, { requestId: 'after-gap' }),
    ).rejects.toMatchObject({ code: 'not_connected' });
    await client.close();
  });

  it('chunks deadlines beyond the Node timer horizon instead of firing early', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'long-deadline', 'full', { now: () => 1_000 });
      const process = await completeConnect(client, harness, 'desktop-long-deadline');
      process.takeWrittenMessages();
      const result = client.request('system.health', {}, {
        requestId: 'long-deadline-request',
        deadlineMs: MAX_NODE_TIMER_DELAY_MS + 50,
      });
      const outcome = result.catch((error: unknown) => error);
      process.takeWrittenMessages();

      await vi.advanceTimersByTimeAsync(MAX_NODE_TIMER_DELAY_MS);
      expect(process.takeWrittenMessages()).toEqual([]);
      await vi.advanceTimersByTimeAsync(49);
      expect(process.takeWrittenMessages()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ code: 'deadline_exceeded' });
      expect(process.takeWrittenMessages()).toContainEqual(
        expect.objectContaining({ type: 'cancel', targetRequestId: 'long-deadline-request' }),
      );
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unsafe timer horizons and bounded identifiers transactionally', async () => {
    const tooLongProfileId = 'p'.repeat(SSH_TEXT_LIMITS.profileId + 1);
    expect(() => new SshAgentDeckClient(profile(tooLongProfileId))).toThrowError('profile.id');
    expect(() =>
      makeClient(new FakeSpawnHarness(), 'timer-bound', 'full', {
        timing: { handshakeTimeoutMs: MAX_NODE_TIMER_DELAY_MS + 1 },
      }),
    ).toThrowError('handshakeTimeoutMs');
    expect(() =>
      makeClient(new FakeSpawnHarness(), 'reconnect-bound', 'full', {
        reconnect: { maxDelayMs: MAX_NODE_TIMER_DELAY_MS + 1 },
      }),
    ).toThrowError('maxDelayMs');
    expect(() =>
      makeClient(new FakeSpawnHarness(), 'heartbeat-bound', 'full', {
        timing: { pingIntervalMs: MAX_NODE_TIMER_DELAY_MS + 1, pongTimeoutMs: 1 },
      }),
    ).toThrowError('pingIntervalMs');
    expect(() =>
      makeClient(new FakeSpawnHarness(), 'shutdown-bound', 'full', {
        timing: { childExitGraceMs: MAX_NODE_TIMER_DELAY_MS + 1 },
      }),
    ).toThrowError('childExitGraceMs');

    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'transactional-cursor');
    await expect(
      client.connect({
        ...makeClientHello('c'.repeat(SSH_TEXT_LIMITS.clientId + 1), 'full', 99),
      }),
    ).rejects.toMatchObject({ code: 'incompatible_handshake' });
    expect(client.lastEventRevision).toBe(0);
    expect(harness.calls).toHaveLength(0);

    const connected = client.connect(makeClientHello('desktop-transactional', 'full', 3));
    const process = harness.latest;
    process.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: makeHostHello('desktop-transactional', 'full', { eventRevision: 3 }),
    } as unknown as JsonValue);
    await connected;
    expect(client.lastEventRevision).toBe(3);
    process.takeWrittenMessages();
    await expect(
      client.request('system.health', {}, { requestId: 'r'.repeat(SSH_TEXT_LIMITS.requestId + 1) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      client.request(
        'session.create',
        { adapterId: 'codex-cli', cwd: '/remote', options: {} },
        { idempotencyKey: 'i'.repeat(SSH_TEXT_LIMITS.idempotencyKey + 1) },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(process.takeWrittenMessages().some((message) => hasMessageType(message, 'request'))).toBe(
      false,
    );
    await client.close();
  });

  it('uses the HostHello revision as the baseline when the first cursor is omitted', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'host-baseline');
    const hello = makeClientHello('desktop-host-baseline');
    delete hello.lastEventRevision;
    const connected = client.connect(hello);
    const process = harness.latest;
    process.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: makeHostHello('desktop-host-baseline', 'full', { eventRevision: 514 }),
    } as unknown as JsonValue);
    await connected;
    expect(client.lastEventRevision).toBe(514);
    client.subscribe(514, () => undefined);
    expect(process.takeWrittenMessages()).toContainEqual(
      expect.objectContaining({ type: 'subscribe', afterRevision: 514 }),
    );
    await client.close();
  });
});
