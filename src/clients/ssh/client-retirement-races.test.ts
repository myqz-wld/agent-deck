import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@contracts/index';

import { completeConnect, makeClient } from './__tests__/client-fixture';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from './__tests__/fake-process';
import type { SpawnSshProcess } from './types';

const RETIREMENT_TIMING = {
  pingIntervalMs: 0,
  pongTimeoutMs: 0,
  childExitGraceMs: 10,
  childExitKillWaitMs: 10,
} as const;

describe('SshAgentDeckClient child retirement fencing', () => {
  it('does not spawn a reconnect until a stubborn old child exits after SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'retire-before-spawn', 'full', {
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
        timing: RETIREMENT_TIMING,
      });
      const first = await completeConnect(client, harness, 'desktop-retire-before-spawn');
      first.exitOnSigterm = false;
      first.emit('error', new Error('transport failed'));
      const joined = client.connect(makeClientHello('desktop-retire-before-spawn'));
      expect(first.killedSignals).toEqual(['SIGTERM']);
      expect(harness.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(first.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(harness.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.calls).toHaveLength(2);
      const second = harness.latest;
      second.emitMessage({
        type: 'hello-result',
        requestId: helloRequestId(second),
        hello: makeHostHello('desktop-retire-before-spawn'),
      } as unknown as JsonValue);
      await expect(joined).resolves.toMatchObject({ instanceId: 'server-a' });
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins repeated connect calls to one automatic reconnect handshake', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'join-reconnect-handshake', 'full', {
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
        timing: RETIREMENT_TIMING,
      });
      const first = await completeConnect(client, harness, 'desktop-join-reconnect');
      first.exit(255);
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.calls).toHaveLength(2);
      const second = harness.latest;

      const joinedA = client.connect(makeClientHello('desktop-join-reconnect'));
      const joinedB = client.connect(makeClientHello('desktop-join-reconnect'));
      expect(harness.calls).toHaveLength(2);
      second.emitMessage({
        type: 'hello-result',
        requestId: helloRequestId(second),
        hello: makeHostHello('desktop-join-reconnect'),
      } as unknown as JsonValue);
      const [helloA, helloB] = await Promise.all([joinedA, joinedB]);
      expect(helloA).toEqual(helloB);
      expect(harness.calls).toHaveLength(2);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins a connect called reentrantly while an automatic attempt is starting', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'join-attempt-state', 'full', {
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
        timing: RETIREMENT_TIMING,
      });
      const first = await completeConnect(client, harness, 'desktop-join-attempt-state');
      let reconnectStates = 0;
      let joined: Promise<unknown> | null = null;
      const subscription = client.onConnectionState((state) => {
        if (state.status !== 'reconnecting' || state.attempt !== 1) return;
        reconnectStates += 1;
        if (reconnectStates === 2) {
          joined = client.connect(makeClientHello('desktop-join-attempt-state'));
        }
      });

      first.exit(255);
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.calls).toHaveLength(2);
      const second = harness.latest;
      second.emitMessage({
        type: 'hello-result',
        requestId: helloRequestId(second),
        hello: makeHostHello('desktop-join-attempt-state'),
      } as unknown as JsonValue);
      await expect(joined).resolves.toMatchObject({ instanceId: 'server-a' });
      expect(harness.calls).toHaveLength(2);
      subscription.close();
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails terminally with child_exit_timeout and never overlaps another child', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'stuck-retirement', 'full', {
        reconnect: { initialDelayMs: 1, maxDelayMs: 1, multiplier: 1, maxAttempts: 1 },
        timing: RETIREMENT_TIMING,
      });
      const first = await completeConnect(client, harness, 'desktop-stuck-retirement');
      first.exitOnSigterm = false;
      first.exitOnSigkill = false;
      const pending = client
        .request('system.health', {}, { requestId: 'pending-on-stuck-child' })
        .catch((error: unknown) => error);
      first.emit('error', new Error('transport failed'));
      await vi.advanceTimersByTimeAsync(20);

      await expect(pending).resolves.toMatchObject({ code: 'child_exit_timeout' });
      expect(client.connectionState).toMatchObject({
        status: 'offline',
        errorCode: 'child_exit_timeout',
      });
      expect(harness.calls).toHaveLength(1);
      await expect(
        client.request('system.health', {}, { requestId: 'after-child-timeout' }),
      ).rejects.toMatchObject({ code: 'not_connected' });
      await expect(
        client.connect(makeClientHello('desktop-stuck-retirement')),
      ).rejects.toMatchObject({ code: 'child_exit_timeout' });
      expect(harness.calls).toHaveLength(1);
      await expect(client.close()).rejects.toMatchObject({ code: 'child_exit_timeout' });
      expect(first.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts and retires a child when request-id creation throws during setup', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'setup-throw', 'full', {
      createRequestId: () => {
        throw new Error('id factory failed');
      },
      timing: RETIREMENT_TIMING,
    });
    await expect(client.connect(makeClientHello('desktop-setup-throw'))).rejects.toThrow(
      'id factory failed',
    );
    expect(harness.calls).toHaveLength(1);
    expect(harness.latest.killedSignals).toEqual(['SIGTERM']);
    expect(harness.latest.hasExited).toBe(true);
    await client.close();
  });

  it('retires an adopted child when writer setup throws', async () => {
    const harness = new FakeSpawnHarness();
    const spawn: SpawnSshProcess = (binary, argv, options) => {
      const child = harness.spawn(binary, argv, options);
      (child.stdin as unknown as { on: () => never }).on = () => {
        throw new Error('writer setup failed');
      };
      return child;
    };
    const client = makeClient(harness, 'writer-setup-throw', 'full', {
      spawn,
      timing: RETIREMENT_TIMING,
    });
    await expect(client.connect(makeClientHello('desktop-writer-setup-throw'))).rejects.toThrow(
      'writer setup failed',
    );
    expect(harness.calls).toHaveLength(1);
    expect(harness.latest.killedSignals).toEqual(['SIGTERM']);
    expect(harness.latest.hasExited).toBe(true);
    await client.close();
  });

  it('memoizes retirement across close and reconnect failure races', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'close-retirement-race', 'full', {
        reconnect: { initialDelayMs: 1, maxDelayMs: 1, multiplier: 1, maxAttempts: 1 },
        timing: RETIREMENT_TIMING,
      });
      const first = await completeConnect(client, harness, 'desktop-close-retirement-race');
      first.exitOnSigterm = false;
      first.emit('error', new Error('transport failed'));
      const joined = client
        .connect(makeClientHello('desktop-close-retirement-race'))
        .catch((error: unknown) => error);
      const closing = client.close();
      expect(first.killedSignals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(10);
      await expect(closing).resolves.toBeUndefined();
      await expect(joined).resolves.toMatchObject({ code: 'connection_closed' });
      expect(first.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(harness.calls).toHaveLength(1);
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects reconnect joiners on a terminal handshake without hanging', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'terminal-reconnect-waiter', 'full', {
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
        timing: RETIREMENT_TIMING,
      });
      const first = await completeConnect(client, harness, 'desktop-terminal-waiter');
      first.exit(255);
      await vi.advanceTimersByTimeAsync(10);
      const second = harness.latest;
      const joined = client.connect(makeClientHello('desktop-terminal-waiter'));
      second.emitMessage({
        type: 'error',
        requestId: helloRequestId(second),
        error: {
          code: 'incompatible_protocol',
          message: 'protocol rejected',
          retryable: false,
          currentRevision: null,
          details: null,
        },
      });
      await expect(joined).rejects.toMatchObject({ code: 'incompatible_protocol' });
      expect(harness.calls).toHaveLength(2);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
