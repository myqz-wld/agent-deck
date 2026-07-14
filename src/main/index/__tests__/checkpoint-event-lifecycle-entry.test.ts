import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { TypedEventBus } from '../../event-bus';
import { ContinuationCheckpointRefreshService } from '../../session/continuation-context/checkpoint-refresh-service';

function session(id: string): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo',
    title: id,
    source: 'sdk',
    lifecycle: 'dormant',
    activity: 'idle',
    startedAt: 0,
    lastEventAt: 0,
    endedAt: null,
    archivedAt: null,
  };
}

function emptyEstimate(sessionId: string) {
  return {
    sessionId,
    captureRevision: 0,
    rebuildAfterRevision: 0,
    checkpointThroughRevision: 0,
    checkpointCreatedAt: null,
    estimatedTokens: 0,
    sourceRows: 0,
    saturated: false,
  };
}

describe('checkpoint refresh manager-event lifecycle entry', () => {
  const services: ContinuationCheckpointRefreshService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()));
  });

  it('startup recovery scans persisted active/dormant sessions after a process restart', async () => {
    const restored = session('restored');
    const estimateBacklog = vi.fn((sessionId: string) => emptyEstimate(sessionId));
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus: new TypedEventBus(),
        now: () => 31 * 60_000,
        listSessions: (_limit, offset) => offset === 0 ? [restored] : [],
        getSession: (id) => id === restored.id ? restored : null,
        checkpointBaseline: () => 0,
        estimateBacklog,
        refresh: vi.fn(),
      },
    );
    services.push(service);

    service.start();

    await vi.waitFor(() => expect(estimateBacklog).toHaveBeenCalledWith(
      restored.id,
      expect.any(AbortSignal),
    ));
  });

  it('event-bus rename and delete cancel obsolete estimates and re-observe only the current id', async () => {
    const bus = new TypedEventBus();
    const sessions = new Map<string, SessionRecord>();
    const signals = new Map<string, AbortSignal>();
    const estimateBacklog = vi.fn((sessionId: string, signal: AbortSignal) => {
      signals.set(sessionId, signal);
      return new Promise<ReturnType<typeof emptyEstimate>>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error(`cancelled:${sessionId}`);
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const service = new ContinuationCheckpointRefreshService(
      {
        continuationCheckpointAutoRefreshEnabled: true,
        continuationCheckpointAutoRefreshIntervalMinutes: 30,
      },
      {
        bus,
        now: () => 31 * 60_000,
        listSessions: () => [],
        getSession: (id) => sessions.get(id) ?? null,
        checkpointBaseline: () => 0,
        estimateBacklog,
        refresh: vi.fn(),
      },
    );
    services.push(service);
    service.start();

    const oldSession = session('temporary-id');
    sessions.set(oldSession.id, oldSession);
    bus.emit('session-upserted', oldSession);
    await vi.waitFor(() => expect(signals.has(oldSession.id)).toBe(true));

    const renamed = session('provider-id');
    sessions.delete(oldSession.id);
    sessions.set(renamed.id, renamed);
    bus.emit('session-renamed', { from: oldSession.id, to: renamed.id });

    await vi.waitFor(() => {
      expect(signals.get(oldSession.id)?.aborted).toBe(true);
      expect(signals.has(renamed.id)).toBe(true);
    });

    sessions.delete(renamed.id);
    bus.emit('session-removed', renamed.id);
    await vi.waitFor(() => expect(signals.get(renamed.id)?.aborted).toBe(true));
    expect(estimateBacklog.mock.calls.map(([id]) => id)).toEqual([
      oldSession.id,
      renamed.id,
    ]);
  });
});
