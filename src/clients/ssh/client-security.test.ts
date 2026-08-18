import { describe, expect, it, vi } from 'vitest';

import type { HostHello, JsonValue } from '@contracts/index';

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

function emitError(
  process: FakeSpawnHarness['latest'],
  requestId: string,
  code: 'access_denied' | 'revoked',
): void {
  process.emitMessage({
    type: 'error',
    requestId,
    error: {
      code,
      message: code,
      retryable: false,
      currentRevision: null,
      details: null,
    },
  });
}

describe('SshAgentDeckClient immutable trust and terminal controls', () => {
  it('snapshots trust inputs for reconnect and isolates HostHello/state observers', async () => {
    vi.useFakeTimers();
    try {
      const source = profile('immutable');
      const harness = new FakeSpawnHarness();
      const client = new SshAgentDeckClient(source, {
        spawn: harness.spawn,
        reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
        timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
      });
      source.hostname = 'mutated.example.test';
      source.identityFile = '/tmp/mutated-key';
      source.knownHostsFile = '/tmp/mutated-known-hosts';
      expect(Object.isFrozen(client.profile)).toBe(true);

      client.onConnectionState(() => {
        throw new Error('observer failure');
      });
      const observed: HostHello[] = [];
      client.onConnectionState((state) => {
        if (state.hello) {
          observed.push(state.hello);
          (state.hello.authoritativeCore as { id: string }).id = 'observer-mutated';
        }
      });
      const connected = client.connect(makeClientHello('desktop-immutable'));
      const firstProcess = harness.latest;
      const hostHello = makeHostHello('desktop-immutable');
      firstProcess.emitMessage({
        type: 'hello-result',
        requestId: helloRequestId(firstProcess),
        hello: hostHello,
      } as unknown as JsonValue);
      const returned = await connected;
      (returned.authoritativeCore as { id: string }).id = 'caller-mutated';
      expect(client.connectionState.hello?.authoritativeCore.id).toBe('core-a');
      expect(observed).toHaveLength(1);
      expect(client.connectionState.status).toBe('connected');
      expect(harness.calls[0]?.argv).toContain('agentdeck@immutable.example.test');
      expect(harness.calls[0]?.argv).toContain('/tmp/immutable-key');

      firstProcess.exit(255);
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.calls[1]?.argv).toContain('agentdeck@immutable.example.test');
      expect(harness.calls[1]?.argv).toContain('/tmp/immutable-key');
      expect(harness.calls[1]?.argv.join(' ')).not.toContain('mutated');
      harness.latest.exit(255);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces subscribe failures and treats revoked credentials as terminal', async () => {
    const subscribeHarness = new FakeSpawnHarness();
    const subscribeClient = makeClient(subscribeHarness, 'subscribe-error');
    const subscribeProcess = await completeConnect(
      subscribeClient,
      subscribeHarness,
      'desktop-subscribe-error',
    );
    subscribeProcess.takeWrittenMessages();
    subscribeClient.subscribe(0, () => undefined);
    const subscribe = subscribeProcess
      .takeWrittenMessages()
      .find((message) => hasMessageType(message, 'subscribe'));
    if (!subscribe || typeof subscribe.requestId !== 'string') {
      throw new Error('Missing subscribe request');
    }
    emitError(subscribeProcess, subscribe.requestId, 'access_denied');
    expect(subscribeClient.connectionState).toMatchObject({
      status: 'offline',
      errorCode: 'access_denied',
    });
    await expect(
      subscribeClient.request('system.health', {}, { requestId: 'after-subscribe-error' }),
    ).rejects.toMatchObject({ code: 'not_connected' });
    await subscribeClient.close();

    const revokedHarness = new FakeSpawnHarness();
    const revokedClient = makeClient(revokedHarness, 'revoked');
    const revokedProcess = await completeConnect(revokedClient, revokedHarness, 'desktop-revoked');
    const revokedRequest = revokedClient.request('system.health', {}, { requestId: 'revoked-id' });
    emitError(revokedProcess, 'revoked-id', 'revoked');
    await expect(revokedRequest).rejects.toMatchObject({ code: 'revoked' });
    expect(revokedClient.connectionState).toMatchObject({
      status: 'incompatible',
      errorCode: 'revoked',
    });
    await expect(
      revokedClient.request('system.health', {}, { requestId: 'after-revoked' }),
    ).rejects.toMatchObject({ code: 'not_connected' });
    await revokedClient.close();
  });

  it('keeps ordinary method access errors local and restores Relay only after success', async () => {
    const accessHarness = new FakeSpawnHarness();
    const accessClient = makeClient(accessHarness, 'access-local');
    const accessProcess = await completeConnect(accessClient, accessHarness, 'desktop-access-local');
    const denied = accessClient.request('system.health', {}, { requestId: 'denied' });
    emitError(accessProcess, 'denied', 'access_denied');
    await expect(denied).rejects.toMatchObject({ code: 'access_denied' });
    expect(accessClient.connectionState.status).toBe('connected');
    await accessClient.close();

    const relayHarness = new FakeSpawnHarness();
    const relayClient = makeClient(relayHarness, 'relay-recovery', 'relay');
    const relayProcess = await completeConnect(
      relayClient,
      relayHarness,
      'desktop-relay-recovery',
      'relay',
    );
    const offline = relayClient.request(
      'session.console.list',
      { limit: 25 },
      { requestId: 'worker-offline' },
    );
    relayProcess.emitMessage({
      type: 'error',
      requestId: 'worker-offline',
      error: {
        code: 'worker_offline',
        message: 'worker offline',
        retryable: true,
        currentRevision: null,
        details: null,
      },
    });
    await expect(offline).rejects.toMatchObject({ code: 'worker_offline' });
    expect(relayClient.connectionState.status).toBe('offline');

    const successful = relayClient.request('system.health', {}, { requestId: 'worker-back' });
    expect(relayClient.connectionState.status).toBe('offline');
    relayProcess.emitMessage({
      type: 'result',
      requestId: 'worker-back',
      result: { ok: true, revision: 1 },
      revision: 1,
    });
    await successful;
    expect(relayClient.connectionState.status).toBe('connected');
    await relayClient.close();
  });
});
