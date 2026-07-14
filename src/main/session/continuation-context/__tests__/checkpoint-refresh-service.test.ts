import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { TypedEventBus } from '@main/event-bus';
import { ContinuationCheckpointRefreshService } from '../checkpoint-refresh-service';
import type { BackgroundCheckpointRefreshResult } from '../checkpoint-background-refresh';
import type { CheckpointBacklogEstimator } from '../checkpoint-backlog-worker-client';
import type { CheckpointBacklogEstimate } from '../checkpoint-backlog-estimator';

function session(id: string, activity: SessionRecord['activity']): SessionRecord {
  return {
    id,
    agentId: 'claude-code',
    cwd: '/repo',
    title: id,
    source: 'sdk',
    lifecycle: 'active',
    activity,
    startedAt: 0,
    lastEventAt: 0,
    endedAt: null,
    archivedAt: null,
  };
}

function result(): BackgroundCheckpointRefreshResult {
  return {
    trigger: 'safety',
    captureRevision: 1,
    materializedThroughRevision: 1,
    checkpointThroughRevision: 1,
    refreshed: true,
    foldCalls: 1,
    repairCalls: 0,
    uncoveredRevisionRange: null,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('continuation checkpoint refresh service integration', () => {
  const services: ContinuationCheckpointRefreshService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()));
  });

  it('serializes safety refreshes globally across active sessions', async () => {
    const sessions = [session('a', 'working'), session('b', 'working')];
    const tokens = new Map(sessions.map((item) => [item.id, 48_000]));
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const refresh = vi.fn(async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      tokens.set(request.sessionId, 0);
      return result();
    });
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        listSessions: (limit, offset) => sessions.slice(offset, offset + limit),
        getSession: (id) => sessions.find((item) => item.id === id) ?? null,
        checkpointBaseline: () => 0,
        estimateBacklog: (id) => ({
          sessionId: id,
          captureRevision: 1,
          rebuildAfterRevision: 0,
          checkpointThroughRevision: 0,
          checkpointCreatedAt: null,
          estimatedTokens: tokens.get(id) ?? 0,
          sourceRows: 1,
          saturated: false,
        }),
        refresh,
      },
    );
    services.push(service);
    service.start();

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(active).toBe(1);
    releases.shift()!();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(active).toBe(1);
    releases.shift()!();
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maxActive).toBe(1);
  });

  it('honors the 8k normal floor after interval and quiet eligibility', async () => {
    const idle = session('idle', 'idle');
    let tokens = 7_999;
    const refresh = vi.fn(async () => {
      tokens = 0;
      return result();
    });
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        now: () => 31 * 60_000,
        listSessions: () => [idle],
        getSession: () => idle,
        checkpointBaseline: () => 0,
        estimateBacklog: () => ({
          sessionId: idle.id,
          captureRevision: 1,
          rebuildAfterRevision: 0,
          checkpointThroughRevision: 0,
          checkpointCreatedAt: null,
          estimatedTokens: tokens,
          sourceRows: 1,
          saturated: false,
        }),
        refresh,
      },
    );
    services.push(service);
    service.start();
    await flush();
    expect(refresh).not.toHaveBeenCalled();

    tokens = 8_000;
    idle.lastEventAt = 1;
    service.updateSettings({
      continuationCheckpointAutoRefreshEnabled: true,
      continuationCheckpointAutoRefreshIntervalMinutes: 30,
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('foreground lease aborts and waits for same-session background work', async () => {
    const activeSession = session('foreground', 'working');
    let tokens = 48_000;
    const providerRelease: { current: (() => void) | null } = { current: null };
    let observedAbort = false;
    const refresh = vi.fn(
      (request) =>
        new Promise<BackgroundCheckpointRefreshResult>((resolve) => {
          providerRelease.current = () => resolve(result());
          request.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
            },
            { once: true },
          );
        }),
    );
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        listSessions: () => [activeSession],
        getSession: () => activeSession,
        checkpointBaseline: () => 0,
        estimateBacklog: () => ({
          sessionId: activeSession.id,
          captureRevision: 1,
          rebuildAfterRevision: 0,
          checkpointThroughRevision: 0,
          checkpointCreatedAt: null,
          estimatedTokens: tokens,
          sourceRows: 1,
          saturated: false,
        }),
        refresh,
      },
    );
    services.push(service);
    service.start();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    let leaseSettled = false;
    const leasePromise = service.acquireForegroundLease(activeSession.id).then((release) => {
      leaseSettled = true;
      return release;
    });
    await flush();
    expect(refresh.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(observedAbort).toBe(true);
    expect(leaseSettled).toBe(false);
    providerRelease.current?.();
    const release = await leasePromise;
    tokens = 0;
    release();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps active waiting sessions busy but treats stale dormant working state as idle', async () => {
    const bus = new TypedEventBus();
    const candidate = session('provider-state', 'waiting');
    let tokens = 8_000;
    const refresh = vi.fn(async () => {
      tokens = 0;
      return result();
    });
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus,
        now: () => 31 * 60_000,
        listSessions: () => [candidate],
        getSession: () => candidate,
        checkpointBaseline: () => 0,
        estimateBacklog: () => ({
          sessionId: candidate.id,
          captureRevision: 1,
          rebuildAfterRevision: 0,
          checkpointThroughRevision: 0,
          checkpointCreatedAt: null,
          estimatedTokens: tokens,
          sourceRows: 1,
          saturated: false,
        }),
        refresh,
      },
    );
    services.push(service);
    service.start();
    await flush();
    expect(refresh).not.toHaveBeenCalled();

    candidate.lifecycle = 'dormant';
    candidate.activity = 'working';
    bus.emit('session-upserted', candidate);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('foreground lease does not wait for unrelated background work ahead of a queued refresh', async () => {
    const sessions = [session('busy', 'working'), session('queued', 'working')];
    const firstRelease: { current: (() => void) | null } = { current: null };
    const refresh = vi.fn(
      async (request): Promise<BackgroundCheckpointRefreshResult> => {
        if (request.sessionId === 'busy') {
          await new Promise<void>((resolve) => {
            firstRelease.current = resolve;
          });
        }
        return result();
      },
    );
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        listSessions: (limit, offset) => sessions.slice(offset, offset + limit),
        getSession: (id) => sessions.find((item) => item.id === id) ?? null,
        checkpointBaseline: () => 0,
        estimateBacklog: (id) => ({
          sessionId: id,
          captureRevision: 1,
          rebuildAfterRevision: 0,
          checkpointThroughRevision: 0,
          checkpointCreatedAt: null,
          estimatedTokens: 48_000,
          sourceRows: 1,
          saturated: false,
        }),
        refresh,
      },
    );
    services.push(service);
    service.start();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await flush();

    const leasePromise = service.acquireForegroundLease('queued');
    const acquiredPromptly = await Promise.race([
      leasePromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    firstRelease.current?.();
    const releaseLease = await leasePromise;
    releaseLease();

    expect(acquiredPromptly).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('awaits an asynchronous worker estimate without blocking the event loop or using stale session state', async () => {
    const idle = session('async-estimate', 'idle');
    const backlogResult = () => ({
      sessionId: idle.id,
      captureRevision: 1,
      rebuildAfterRevision: 0,
      checkpointThroughRevision: 0,
      checkpointCreatedAt: null,
      estimatedTokens: 48_000,
      sourceRows: 1,
      saturated: false,
    });
    let resolveEstimate!: (value: ReturnType<typeof backlogResult>) => void;
    const estimator: CheckpointBacklogEstimator = {
      estimate: vi.fn(() => new Promise<CheckpointBacklogEstimate | null>((resolve) => {
        resolveEstimate = resolve;
      })),
      stop: vi.fn(async () => undefined),
    };
    const refresh = vi.fn(async () => result());
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        listSessions: () => [idle],
        getSession: () => idle,
        checkpointBaseline: () => 0,
        backlogEstimator: estimator,
        refresh,
      },
    );
    services.push(service);
    service.start();
    expect(estimator.estimate).toHaveBeenCalledTimes(1);

    const heartbeat = await new Promise<'event-loop'>((resolve) =>
      setImmediate(() => resolve('event-loop'))
    );
    expect(heartbeat).toBe('event-loop');
    expect(refresh).not.toHaveBeenCalled();

    idle.archivedAt = 1;
    resolveEstimate(backlogResult());
    await flush();
    expect(refresh).not.toHaveBeenCalled();

    await service.stop();
    expect(estimator.stop).toHaveBeenCalledTimes(1);
  });

  it('aborts an asynchronous worker estimate before granting a foreground lease and closes it on stop', async () => {
    const activeSession = session('async-cancel', 'working');
    const observedSignal: { current: AbortSignal | null } = { current: null };
    const estimator: CheckpointBacklogEstimator = {
      estimate: vi.fn((_sessionId: string, signal: AbortSignal) => {
        observedSignal.current = signal;
        return new Promise<CheckpointBacklogEstimate | null>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }),
      stop: vi.fn(async () => undefined),
    };
    const refresh = vi.fn(async () => result());
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        listSessions: () => [activeSession],
        getSession: () => activeSession,
        checkpointBaseline: () => 0,
        backlogEstimator: estimator,
        refresh,
      },
    );
    services.push(service);
    service.start();
    await vi.waitFor(() => expect(estimator.estimate).toHaveBeenCalledTimes(1));

    const release = await service.acquireForegroundLease(activeSession.id);
    expect(observedSignal.current?.aborted).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    activeSession.archivedAt = 1;
    release();

    await service.stop();
    expect(estimator.stop).toHaveBeenCalledTimes(1);
  });

  it('drains the refresh queue before propagating a worker-stop failure', async () => {
    const stopFailure = new Error('worker stop failed');
    const estimator: CheckpointBacklogEstimator = {
      estimate: vi.fn(async () => null),
      stop: vi.fn(async () => {
        throw stopFailure;
      }),
    };
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        listSessions: () => [],
        getSession: () => null,
        checkpointBaseline: () => 0,
        backlogEstimator: estimator,
      },
    );
    services.push(service);
    service.start();
    let releaseRefresh!: () => void;
    const refreshTail = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    (service as unknown as { refreshTail: Promise<void> }).refreshTail = refreshTail;

    let settled = false;
    const stopping = service.stop().finally(() => {
      settled = true;
    });
    await flush();
    expect(estimator.stop).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseRefresh();
    await expect(stopping).rejects.toBe(stopFailure);
    expect(settled).toBe(true);
  });

  it('re-evaluates a partially materialized safety backlog without waiting for new activity', async () => {
    const activeSession = session('partial-safety', 'working');
    let checkpointThroughRevision = 0;
    let estimatedTokens = 48_000;
    const refresh = vi.fn(async (): Promise<BackgroundCheckpointRefreshResult> => {
      if (checkpointThroughRevision === 0) {
        checkpointThroughRevision = 50;
        return {
          ...result(),
          captureRevision: 100,
          materializedThroughRevision: 50,
          checkpointThroughRevision,
          uncoveredRevisionRange: { from: 50, to: 100 },
        };
      }
      checkpointThroughRevision = 100;
      estimatedTokens = 0;
      return {
        ...result(),
        captureRevision: 100,
        materializedThroughRevision: 100,
        checkpointThroughRevision,
      };
    });
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        listSessions: () => [activeSession],
        getSession: () => activeSession,
        checkpointBaseline: () => 0,
        estimateBacklog: () => ({
          sessionId: activeSession.id,
          captureRevision: 100,
          rebuildAfterRevision: 0,
          checkpointThroughRevision,
          checkpointCreatedAt: null,
          estimatedTokens,
          sourceRows: 10_000,
          saturated: true,
        }),
        refresh,
      },
    );
    services.push(service);
    service.start();

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(checkpointThroughRevision).toBe(100);
  });
});
