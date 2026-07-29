import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';

interface HistoryCandidate {
  id: string;
  cliSessionId: string | null;
  lastEventAt: number;
}

interface HistoryCursor {
  id: string;
  lastEventAt: number;
}

const activeFindCalls: Array<{ threshold: number; limit: number }> = [];
const dormantFindCalls: Array<{ threshold: number; limit: number }> = [];
const historyFindCalls: Array<{
  threshold: number;
  cursor: HistoryCursor | null;
  limit: number;
}> = [];
const batchAdvanceCalls: Array<{
  ids: readonly string[];
  from: string;
  to: string;
}> = [];
const batchDeleteCalls: HistoryCandidate[][] = [];
const clearMarkerCalls: string[] = [];
const leaveCalls: string[] = [];
const browserDisposeCalls: string[] = [];
const emitCalls: Array<{ name: string; payload: unknown }> = [];

let activeRows: SessionRecord[] = [];
let dormantRows: SessionRecord[] = [];
let historyRows: HistoryCandidate[] = [];
let recordsById = new Map<string, SessionRecord>();
let failActiveReads = 0;
let failDormantReads = 0;
let failHistoryReads = 0;
let forceZeroAdvance = false;
let sideEffectGates = new Map<string, Promise<void>>();

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    findActiveExpiring: (threshold: number, limit: number) => {
      activeFindCalls.push({ threshold, limit });
      if (failActiveReads-- > 0) throw new Error('database is locked');
      return activeRows.slice(0, limit);
    },
    findDormantExpiring: (threshold: number, limit: number) => {
      dormantFindCalls.push({ threshold, limit });
      if (failDormantReads-- > 0) throw new Error('database is locked');
      return dormantRows.slice(0, limit);
    },
    batchAdvanceLifecycle: (
      ids: readonly string[],
      from: 'active' | 'dormant',
      to: 'dormant' | 'closed',
      ts: number,
    ) => {
      batchAdvanceCalls.push({ ids, from, to });
      if (forceZeroAdvance) return [];
      const source = from === 'active' ? activeRows : dormantRows;
      const selected = source.filter((row) => ids.includes(row.id));
      const selectedIds = new Set(selected.map((row) => row.id));
      if (from === 'active') {
        activeRows = activeRows.filter((row) => !selectedIds.has(row.id));
      } else {
        dormantRows = dormantRows.filter((row) => !selectedIds.has(row.id));
      }
      return selected.map((row) => {
        const updated = {
          ...row,
          lifecycle: to,
          endedAt: to === 'closed' ? ts : null,
        } as SessionRecord;
        recordsById.set(updated.id, updated);
        return updated;
      });
    },
    findHistoryOlderThan: (
      threshold: number,
      cursor: HistoryCursor | null,
      limit: number,
    ) => {
      historyFindCalls.push({ threshold, cursor, limit });
      if (failHistoryReads-- > 0) throw new Error('database is locked');
      return historyRows
        .filter((row) => row.lastEventAt < threshold)
        .filter(
          (row) =>
            !cursor ||
            row.lastEventAt > cursor.lastEventAt ||
            (row.lastEventAt === cursor.lastEventAt && row.id > cursor.id),
        )
        .sort((a, b) => a.lastEventAt - b.lastEventAt || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    batchDeleteHistory: (candidates: readonly HistoryCandidate[]) => {
      batchDeleteCalls.push([...candidates]);
      const removedIds = new Set(candidates.map((row) => row.id));
      historyRows = historyRows.filter((row) => !removedIds.has(row.id));
      for (const id of removedIds) recordsById.delete(id);
      return [...candidates];
    },
    get: (id: string) => recordsById.get(id) ?? null,
    findByCliSessionId: (cliSessionId: string) =>
      [...recordsById.values()].find((row) => row.cliSessionId === cliSessionId) ?? null,
    clearCwdReleaseMarker: (id: string) => {
      clearMarkerCalls.push(id);
      const row = recordsById.get(id);
      if (row) recordsById.set(id, { ...row, cwdReleaseMarker: null });
    },
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: (name: string, payload: unknown) => {
      emitCalls.push({ name, payload });
    },
  },
}));

vi.mock('@main/browser-use/session-browser', () => ({
  disposeSessionBrowser: async (sessionId: string) => {
    browserDisposeCalls.push(sessionId);
  },
}));

vi.mock('@main/session/manager-team-coordinator', () => ({
  applyClosedSideEffects: async (
    sessionId: string,
    opts: { onClearedBeforeLeave?: () => void } = {},
  ) => {
    clearMarkerCalls.push(sessionId);
    const row = recordsById.get(sessionId);
    if (row) recordsById.set(sessionId, { ...row, cwdReleaseMarker: null });
    opts.onClearedBeforeLeave?.();
    const gate = sideEffectGates.get(sessionId);
    if (gate) await gate;
    leaveCalls.push(sessionId);
  },
  leaveTeamsAndAutoArchive: async () => {},
  archiveTeamsIfOrphaned: async () => {},
  unarchiveTeamsForRevivedLead: async () => {},
}));

import { LifecycleScheduler } from '@main/session/lifecycle-scheduler';
import { sessionManager } from '@main/session/manager';

function makeRecord(
  id: string,
  lifecycle: SessionRecord['lifecycle'] = 'dormant',
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo',
    title: id,
    source: 'sdk',
    lifecycle,
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 10,
    endedAt: lifecycle === 'closed' ? 10 : null,
    archivedAt: null,
    cliSessionId: `cli-${id}`,
    ...overrides,
  };
}

function makeScheduler(overrides: Record<string, number> = {}): LifecycleScheduler {
  return new LifecycleScheduler({
    activeWindowMs: 1_000,
    closeAfterMs: 2_000,
    historyRetentionDays: 1,
    catchUpDelayMs: 1,
    ...overrides,
  });
}

function makeLateEvent(sessionId: string): AgentEvent {
  return {
    sessionId,
    agentId: 'codex-cli',
    source: 'hook',
    kind: 'message',
    ts: Date.now(),
    payload: { role: 'assistant', text: 'late' },
  };
}

beforeEach(() => {
  activeFindCalls.length = 0;
  dormantFindCalls.length = 0;
  historyFindCalls.length = 0;
  batchAdvanceCalls.length = 0;
  batchDeleteCalls.length = 0;
  clearMarkerCalls.length = 0;
  leaveCalls.length = 0;
  browserDisposeCalls.length = 0;
  emitCalls.length = 0;
  activeRows = [];
  dormantRows = [];
  historyRows = [];
  recordsById = new Map();
  failActiveReads = 0;
  failDormantReads = 0;
  failHistoryReads = 0;
  forceZeroAdvance = false;
  sideEffectGates = new Map();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LifecycleScheduler phase isolation and transitions', () => {
  it('keeps close epoch, browser, team, marker, and fresh upsert side effects', async () => {
    const row = makeRecord('close-me', 'dormant', { cwdReleaseMarker: '/stale' });
    dormantRows = [row];
    recordsById.set(row.id, row);

    makeScheduler({ historyRetentionDays: 0 }).scan();
    await vi.waitFor(() => expect(leaveCalls).toEqual(['close-me']));

    expect(clearMarkerCalls).toEqual(['close-me']);
    expect(browserDisposeCalls).toEqual(['close-me']);
    expect(emitCalls).toContainEqual({
      name: 'session-upserted',
      payload: expect.objectContaining({
        id: 'close-me',
        lifecycle: 'closed',
        cwdReleaseMarker: null,
      }),
    });
    expect(sessionManager.getCloseEpoch('close-me')).toBeGreaterThan(0);
    sessionManager.forgetCloseEpoch('close-me');
  });

  it('isolates a DB lock to one phase and lets other phases plus a later interval tick run', async () => {
    vi.useFakeTimers();
    failActiveReads = 1;
    activeRows = [makeRecord('active-later', 'active')];
    dormantRows = [makeRecord('dormant-now', 'dormant')];
    recordsById.set('active-later', activeRows[0]!);
    recordsById.set('dormant-now', dormantRows[0]!);

    const scheduler = makeScheduler({ historyRetentionDays: 0, intervalMs: 20 });
    scheduler.start();

    expect(recordsById.get('dormant-now')?.lifecycle).toBe('closed');
    expect(recordsById.get('active-later')?.lifecycle).toBe('active');

    await vi.advanceTimersByTimeAsync(20);

    expect(recordsById.get('active-later')?.lifecycle).toBe('dormant');
    expect(activeFindCalls).toHaveLength(2);
    scheduler.stop();
  });

  it('does not schedule zero-progress transition catch-up', () => {
    vi.useFakeTimers();
    forceZeroAdvance = true;
    activeRows = Array.from({ length: 100 }, (_, index) =>
      makeRecord(`stale-${index}`, 'active'),
    );

    makeScheduler({ historyRetentionDays: 0 }).scan();

    expect(activeFindCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('LifecycleScheduler bounded catch-up', () => {
  it.each([
    [100, 2],
    [101, 2],
    [250, 3],
  ])('drains %i active rows in 100-row one-shot batches', async (count, expectedReads) => {
    vi.useFakeTimers();
    activeRows = Array.from({ length: count }, (_, index) =>
      makeRecord(`active-${index.toString().padStart(3, '0')}`, 'active'),
    );

    makeScheduler({ historyRetentionDays: 0 }).scan();
    await vi.runAllTimersAsync();

    expect(activeRows).toEqual([]);
    expect(activeFindCalls).toHaveLength(expectedReads);
    expect(batchAdvanceCalls.every((call) => call.ids.length <= 100)).toBe(true);
  });

  it('clears interval and pending catch-up timers on stop', () => {
    vi.useFakeTimers();
    activeRows = Array.from({ length: 101 }, (_, index) =>
      makeRecord(`active-${index}`, 'active'),
    );
    const scheduler = makeScheduler({ historyRetentionDays: 0, intervalMs: 60_000 });

    scheduler.start();
    expect(vi.getTimerCount()).toBe(2);
    const readsBeforeStop = activeFindCalls.length;
    scheduler.stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(activeFindCalls).toHaveLength(readsBeforeStop);
  });
});

describe('LifecycleScheduler history purge fencing', () => {
  it('moves a keyset cursor past a full live page so later deletable candidates are not starved', async () => {
    vi.useFakeTimers();
    historyRows = Array.from({ length: 101 }, (_, index) => ({
      id: `history-${index.toString().padStart(3, '0')}`,
      cliSessionId: `cli-history-${index}`,
      lastEventAt: 1,
    }));
    for (const row of historyRows.slice(0, 100)) sessionManager.claimAsSdk(row.id);

    makeScheduler().scan();
    await vi.runAllTimersAsync();

    expect(batchDeleteCalls.flat().map((row) => row.id)).toEqual(['history-100']);
    expect(historyFindCalls[1]?.cursor).toEqual({
      id: 'history-099',
      lastEventAt: 1,
    });
    for (let index = 0; index < 100; index += 1) {
      sessionManager.releaseSdkClaim(`history-${index.toString().padStart(3, '0')}`);
    }
  });

  it('does not purge while close side effects are pending', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    sideEffectGates.set('pending-close', gate);
    const pending = sessionManager.runClosedSideEffects('pending-close', {});
    historyRows = [{
      id: 'pending-close',
      cliSessionId: 'cli-pending-close',
      lastEventAt: 1,
    }];

    makeScheduler().scan();
    expect(batchDeleteCalls).toEqual([]);

    releaseGate();
    await pending;
    makeScheduler().scan();
    expect(batchDeleteCalls.flat().map((row) => row.id)).toEqual(['pending-close']);
  });

  it('fences both application and CLI identities before late events can recreate a purged row', () => {
    historyRows = [{
      id: 'purged-app',
      cliSessionId: 'purged-cli',
      lastEventAt: 1,
    }];

    makeScheduler().scan();
    const emittedBeforeLateEvents = emitCalls.length;
    sessionManager.ingest(makeLateEvent('purged-app'));
    sessionManager.ingest(makeLateEvent('purged-cli'));

    expect(recordsById.has('purged-app')).toBe(false);
    expect(recordsById.has('purged-cli')).toBe(false);
    expect(emitCalls).toHaveLength(emittedBeforeLateEvents);
  });

  it('excludes rows closed in the same tick until their side effects finish', () => {
    const closing = makeRecord('same-tick', 'dormant');
    dormantRows = [closing];
    recordsById.set(closing.id, closing);
    historyRows = [{
      id: 'same-tick',
      cliSessionId: 'cli-same-tick',
      lastEventAt: 1,
    }];

    makeScheduler().scan();

    expect(batchDeleteCalls).toEqual([]);
  });
});
