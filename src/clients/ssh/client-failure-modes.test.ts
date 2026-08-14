import { describe, expect, it, vi } from 'vitest';

import { isJsonObject, type JsonValue } from '@contracts/index';

import { AgentDeckRemoteError, SshTransportError } from './errors';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from './__tests__/fake-process';
import { completeConnect, hasMessageType, makeClient } from './__tests__/client-fixture';

describe('SshAgentDeckClient protocol failure modes', () => {
  it('fails closed on host-key and handshake mismatches without automatic trust', async () => {
    const hostKeyHarness = new FakeSpawnHarness();
    const hostKeyClient = makeClient(hostKeyHarness, 'host-key', 'full', {
      reconnect: { maxAttempts: 8 },
    });
    const hostKeyConnect = hostKeyClient.connect(makeClientHello('desktop-host-key'));
    hostKeyHarness.latest.emitStderr('REMOTE HOST IDENTIFICATION HAS CHANGED!');
    hostKeyHarness.latest.exit(255);
    await expect(hostKeyConnect).rejects.toMatchObject({
      code: 'host_key_verification_failed',
    });
    expect(hostKeyClient.connectionState.status).toBe('incompatible');
    expect(hostKeyHarness.calls).toHaveLength(1);

    const mismatchHarness = new FakeSpawnHarness();
    const mismatchClient = makeClient(mismatchHarness, 'mismatch');
    const mismatchConnect = mismatchClient.connect(makeClientHello('desktop-mismatch'));
    const mismatchProcess = mismatchHarness.latest;
    mismatchProcess.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(mismatchProcess),
      hello: makeHostHello('desktop-mismatch', 'relay'),
    } as unknown as JsonValue);
    await expect(mismatchConnect).rejects.toBeInstanceOf(SshTransportError);
    expect(mismatchClient.connectionState.status).toBe('incompatible');
    expect(mismatchHarness.calls).toHaveLength(1);
  });

  it('categorizes OpenSSH exit 255 without exposing captured stderr', async () => {
    const cases = [
      ['Permission denied (publickey). token=SECRET-MARKER', 'ssh_authentication_failed'],
      [
        'connect to host relay.example port 22: Connection refused SECRET-MARKER',
        'ssh_endpoint_unreachable',
      ],
      ['remote command failed: control socket SECRET-MARKER', 'ssh_remote_command_failed'],
      ['Connection reset by peer SECRET-MARKER', 'ssh_transport_closed'],
    ] as const;
    for (const [stderr, errorCode] of cases) {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, `exit-${errorCode}`);
      const connected = client.connect(makeClientHello(`desktop-${errorCode}`));
      harness.latest.emitStderr(stderr);
      harness.latest.exit(255);
      await expect(connected).rejects.toMatchObject({ code: errorCode });
      expect(client.connectionState).toMatchObject({ status: 'offline', errorCode });
      expect(client.connectionState.reason).not.toContain('SECRET-MARKER');
      await client.close();
    }
  });

  it('treats unknown and duplicate responses as deterministic protocol faults', async () => {
    const unknownHarness = new FakeSpawnHarness();
    const unknownClient = makeClient(unknownHarness, 'unknown');
    const unknownProcess = await completeConnect(unknownClient, unknownHarness, 'desktop-unknown');
    unknownProcess.emitMessage({
      type: 'result',
      requestId: 'never-requested',
      result: null,
      revision: 0,
    });
    expect(unknownClient.connectionState).toMatchObject({
      status: 'incompatible',
      errorCode: 'protocol_violation',
    });

    const duplicateHarness = new FakeSpawnHarness();
    const duplicateClient = makeClient(duplicateHarness, 'duplicate');
    const duplicateProcess = await completeConnect(
      duplicateClient,
      duplicateHarness,
      'desktop-duplicate',
    );
    const result = duplicateClient.request('system.health', {}, { requestId: 'duplicate-id' });
    const response = {
      type: 'result',
      requestId: 'duplicate-id',
      result: { ok: true, revision: 1 },
      revision: 1,
    } as const;
    duplicateProcess.emitMessage(response);
    await result;
    duplicateProcess.emitMessage(response);
    expect(duplicateClient.connectionState.status).toBe('incompatible');
  });

  it('responds to protocol ping and requires the matching pong for its heartbeat', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'heartbeat', 'full', {
        timing: { pingIntervalMs: 10, pongTimeoutMs: 5 },
        reconnect: { maxAttempts: 0 },
      });
      const process = await completeConnect(client, harness, 'desktop-heartbeat');
      process.emitMessage({ type: 'ping', nonce: 'host-ping' });
      expect(process.takeWrittenMessages()).toContainEqual({ type: 'pong', nonce: 'host-ping' });
      await vi.advanceTimersByTimeAsync(10);
      const ping = process
        .takeWrittenMessages()
        .find((message) => hasMessageType(message, 'ping') && typeof message.nonce === 'string');
      expect(ping).toBeDefined();
      if (isJsonObject(ping) && typeof ping.nonce === 'string') {
        process.emitMessage({ type: 'pong', nonce: ping.nonce });
      }
      await vi.advanceTimersByTimeAsync(4);
      expect(client.connectionState.status).toBe('connected');
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps Relay worker_offline errors without tearing down the SSH channel', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'relay', 'relay');
    const process = await completeConnect(client, harness, 'desktop-relay', 'relay');
    const result = client.request('session.list', {}, { requestId: 'relay-list' });
    process.emitMessage({
      type: 'error',
      requestId: 'relay-list',
      error: {
        code: 'worker_offline',
        message: 'Worker is offline',
        retryable: true,
        currentRevision: null,
        details: null,
      },
    });
    await expect(result).rejects.toBeInstanceOf(AgentDeckRemoteError);
    expect(client.connectionState).toMatchObject({
      status: 'offline',
      errorCode: 'worker_offline',
    });
    expect(process.killedSignals).toEqual([]);
    await client.close();
  });
});
