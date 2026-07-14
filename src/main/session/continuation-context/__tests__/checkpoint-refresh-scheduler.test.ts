import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CheckpointRefreshScheduler,
  DEFAULT_CHECKPOINT_REFRESH_INTERVAL_MS,
  DEFAULT_CHECKPOINT_REFRESH_NORMAL_TOKENS,
  DEFAULT_CHECKPOINT_REFRESH_QUIET_MS,
  DEFAULT_CHECKPOINT_REFRESH_SAFETY_TOKENS,
  type CheckpointRefreshBacklogSnapshot,
  type CheckpointRefreshRequest,
} from '../checkpoint-refresh-scheduler';

interface TestSnapshot extends CheckpointRefreshBacklogSnapshot {
  marker: string;
}

function snapshot(
  sessionId: string,
  sourceEventRevision: number,
  uncheckpointedNormalizedTokens: number,
  checkpointEventRevision = 0,
): TestSnapshot {
  return {
    sessionId,
    sourceEventRevision,
    checkpointEventRevision,
    uncheckpointedNormalizedTokens,
    marker: `revision-${sourceEventRevision}`,
  };
}

async function flushBackgroundWork(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

describe('CheckpointRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the confirmed 30m / 60s / 8k / 48k defaults', () => {
    expect(DEFAULT_CHECKPOINT_REFRESH_INTERVAL_MS).toBe(30 * 60 * 1_000);
    expect(DEFAULT_CHECKPOINT_REFRESH_QUIET_MS).toBe(60 * 1_000);
    expect(DEFAULT_CHECKPOINT_REFRESH_NORMAL_TOKENS).toBe(8_000);
    expect(DEFAULT_CHECKPOINT_REFRESH_SAFETY_TOKENS).toBe(48_000);
  });

  it('requires both the normal interval and a continuous quiet window at 8k', async () => {
    let current = snapshot('normal', 1, 8_000);
    const refresh = vi.fn(async (request: CheckpointRefreshRequest<TestSnapshot>) => {
      current = snapshot('normal', request.snapshot.sourceEventRevision, 0, request.snapshot.sourceEventRevision);
    });
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async () => ({ ...current }),
      refresh,
    });

    scheduler.observePersistedActivity({ sessionId: 'normal', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECKPOINT_REFRESH_QUIET_MS);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      DEFAULT_CHECKPOINT_REFRESH_INTERVAL_MS - DEFAULT_CHECKPOINT_REFRESH_QUIET_MS - 1,
    );
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushBackgroundWork();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toMatchObject({ trigger: 'normal' });
    await scheduler.dispose();
  });

  it('does not invoke the refresh callback below 8k, even after interval and quiet elapse', async () => {
    const refresh = vi.fn(async () => undefined);
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async () => snapshot('small', 3, 7_999),
      refresh,
    });

    scheduler.observePersistedActivity({ sessionId: 'small', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECKPOINT_REFRESH_INTERVAL_MS * 2);
    await flushBackgroundWork();

    expect(refresh).not.toHaveBeenCalled();
    await scheduler.dispose();
  });

  it('does not slide the durable interval anchor when later activity omits baselineAt', async () => {
    let current = snapshot('stable-anchor', 1, 8_000);
    const refresh = vi.fn(async (request: CheckpointRefreshRequest<TestSnapshot>) => {
      current = snapshot(
        'stable-anchor',
        request.snapshot.sourceEventRevision,
        0,
        request.snapshot.sourceEventRevision,
      );
    });
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async () => ({ ...current }),
      refresh,
    });

    scheduler.observePersistedActivity({ sessionId: 'stable-anchor', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    current = snapshot('stable-anchor', 2, 8_000);
    scheduler.observePersistedActivity({ sessionId: 'stable-anchor', observedAt: Date.now() });
    await flushBackgroundWork();

    await vi.advanceTimersByTimeAsync(20 * 60 * 1_000 - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0].snapshot.sourceEventRevision).toBe(2);
    await scheduler.dispose();
  });

  it('uses a newer foreground checkpoint as the normal interval anchor after background success', async () => {
    let current = snapshot('foreground-anchor', 1, 48_000);
    const refresh = vi.fn(async (request: CheckpointRefreshRequest<TestSnapshot>) => {
      current = snapshot(
        'foreground-anchor',
        request.snapshot.sourceEventRevision,
        0,
        request.snapshot.sourceEventRevision,
      );
    });
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async () => ({ ...current }),
      refresh,
    });

    scheduler.observePersistedActivity({ sessionId: 'foreground-anchor', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25 * 60 * 1_000);
    scheduler.observeIdle({
      sessionId: 'foreground-anchor',
      observedAt: Date.now(),
      baselineAt: Date.now(),
      lastPersistedAt: Date.now(),
    });
    await flushBackgroundWork();

    await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);
    current = snapshot('foreground-anchor', 2, 8_000, 1);
    scheduler.observePersistedActivity({
      sessionId: 'foreground-anchor',
      observedAt: Date.now(),
      baselineAt: 25 * 60 * 1_000,
    });
    await flushBackgroundWork();

    await vi.advanceTimersByTimeAsync(24 * 60 * 1_000 - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1][0]).toMatchObject({ trigger: 'normal' });
    await scheduler.dispose();
  });

  it('runs a 48k safety refresh immediately while the provider turn is active', async () => {
    let current = snapshot('safety', 4, 47_999);
    const refresh = vi.fn(async (_request: CheckpointRefreshRequest<TestSnapshot>) => undefined);
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async () => ({ ...current }),
      refresh,
    });

    scheduler.observeProviderActive({ sessionId: 'safety', observedAt: 0, baselineAt: 0 });
    scheduler.observePersistedActivity({
      sessionId: 'safety',
      observedAt: 0,
      providerActive: true,
    });
    await flushBackgroundWork();
    expect(refresh).not.toHaveBeenCalled();

    current = snapshot('safety', 5, 48_000);
    scheduler.observePersistedActivity({
      sessionId: 'safety',
      observedAt: 1,
      providerActive: true,
    });
    await flushBackgroundWork();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toMatchObject({
      trigger: 'safety',
      snapshot: { sourceEventRevision: 5, marker: 'revision-5' },
    });
    await scheduler.dispose();
  });

  it('singleflights per session and re-evaluates events observed during a running capture', async () => {
    let current = snapshot('singleflight', 10, 48_000);
    const releases: Array<() => void> = [];
    const requests: Array<CheckpointRefreshRequest<TestSnapshot>> = [];
    const refresh = vi.fn((request: CheckpointRefreshRequest<TestSnapshot>) => {
      requests.push(request);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async () => ({ ...current }),
      refresh,
    });

    scheduler.observePersistedActivity({ sessionId: 'singleflight', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests[0].snapshot.sourceEventRevision).toBe(10);

    current = snapshot('singleflight', 11, 49_000, 0);
    scheduler.observePersistedActivity({ sessionId: 'singleflight', observedAt: 1 });
    scheduler.observePersistedActivity({ sessionId: 'singleflight', observedAt: 2 });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests[0].snapshot.sourceEventRevision).toBe(10);

    current = snapshot('singleflight', 11, 48_000, 10);
    releases.shift()!();
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(requests[1].snapshot.sourceEventRevision).toBe(11);
    expect(requests[1].snapshot).not.toBe(requests[0].snapshot);

    current = snapshot('singleflight', 11, 0, 11);
    releases.shift()!();
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(2);
    await scheduler.dispose();
  });

  it('cancel aborts a run and the next persisted observation re-arms the session', async () => {
    const signals: AbortSignal[] = [];
    const refresh = vi.fn((request: CheckpointRefreshRequest<TestSnapshot>) => {
      signals.push(request.signal);
      return new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async () => snapshot('cancel', 1, 48_000),
      refresh,
    });

    scheduler.observePersistedActivity({ sessionId: 'cancel', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);

    await scheduler.cancelSession('cancel');
    expect(signals[0].aborted).toBe(true);
    scheduler.observePersistedActivity({ sessionId: 'cancel', observedAt: 1 });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(2);

    await scheduler.dispose();
    expect(signals[1].aborted).toBe(true);
  });

  it('remove clears pending work and dispose aborts all active refreshes', async () => {
    const activeSignals: AbortSignal[] = [];
    const refresh = vi.fn((request: CheckpointRefreshRequest<TestSnapshot>) => {
      activeSignals.push(request.signal);
      return new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    let snapshots: Record<string, TestSnapshot> = {
      pending: snapshot('pending', 1, 8_000),
      active: snapshot('active', 1, 48_000),
    };
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>({
      loadBacklogSnapshot: async (sessionId) => ({ ...snapshots[sessionId] }),
      refresh,
    });

    scheduler.observePersistedActivity({ sessionId: 'pending', observedAt: 0, baselineAt: 0 });
    scheduler.observePersistedActivity({ sessionId: 'active', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);

    await scheduler.removeSession('pending');
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECKPOINT_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    await scheduler.dispose();
    expect(activeSignals).toHaveLength(1);
    expect(activeSignals[0].aborted).toBe(true);
    scheduler.observePersistedActivity({ sessionId: 'active', observedAt: Date.now() });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);
    snapshots = {};
  });

  it('backs off and retries refresh failures without leaking diagnostic errors', async () => {
    let current = snapshot('retry', 9, 48_000);
    const reported: unknown[] = [];
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 1) throw new Error('temporary provider failure');
      current = snapshot('retry', 9, 0, 9);
    });
    const scheduler = new CheckpointRefreshScheduler<TestSnapshot>(
      {
        loadBacklogSnapshot: async () => ({ ...current }),
        refresh,
        onError: (error) => {
          reported.push(error);
          throw new Error('diagnostic sink failure must stay handled');
        },
      },
      { policy: { failureRetryMs: 100 } },
    );

    scheduler.observePersistedActivity({ sessionId: 'retry', observedAt: 0, baselineAt: 0 });
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushBackgroundWork();
    expect(refresh).toHaveBeenCalledTimes(2);

    await scheduler.dispose();
  });
});
