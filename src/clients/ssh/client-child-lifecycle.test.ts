import { describe, expect, it, vi } from 'vitest';

import { completeConnect, makeClient } from './__tests__/client-fixture';
import { FakeSpawnHarness } from './__tests__/fake-process';

describe('SshAgentDeckClient local child shutdown', () => {
  it('awaits graceful exit without emitting a remote lifecycle request', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'graceful-close');
    const process = await completeConnect(client, harness, 'desktop-graceful-close');
    process.takeWrittenMessages();
    await client.close();
    expect(process.killedSignals).toEqual(['SIGTERM']);
    expect(process.takeWrittenMessages()).toEqual([]);
    expect(client.connectionState).toMatchObject({
      status: 'closed',
      errorCode: 'connection_closed',
    });
  });

  it('escalates deterministically to SIGKILL when SIGTERM does not exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'forced-close', 'server-core', {
        timing: {
          pingIntervalMs: 0,
          pongTimeoutMs: 0,
          childExitGraceMs: 10,
          childExitKillWaitMs: 10,
        },
      });
      const process = await completeConnect(client, harness, 'desktop-forced-close');
      process.exitOnSigterm = false;
      const closed = client.close();
      expect(process.killedSignals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(10);
      await expect(closed).resolves.toBeUndefined();
      expect(process.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a bounded failure when even SIGKILL has no exit event', async () => {
    vi.useFakeTimers();
    try {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, 'stuck-close', 'server-core', {
        timing: {
          pingIntervalMs: 0,
          pongTimeoutMs: 0,
          childExitGraceMs: 10,
          childExitKillWaitMs: 10,
        },
      });
      const process = await completeConnect(client, harness, 'desktop-stuck-close');
      process.exitOnSigterm = false;
      process.exitOnSigkill = false;
      const outcome = client.close().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      await expect(outcome).resolves.toMatchObject({ code: 'child_exit_timeout' });
      expect(process.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(client.connectionState).toMatchObject({
        status: 'closed',
        errorCode: 'child_exit_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
