import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionRecord } from '@shared/types';
import type {
  HistoryLifecycleCandidate,
} from '@main/store/session-repo/lifecycle';
import {
  ServerCoreSessionLifecycle,
  type ServerCoreLifecycleRepositoryPort,
} from './session-lifecycle';

function record(
  id: string,
  lifecycle: SessionRecord['lifecycle'],
  lastEventAt = 10,
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/workspaces/demo',
    title: id,
    source: 'sdk',
    lifecycle,
    activity: 'finished',
    startedAt: 1,
    lastEventAt,
    endedAt: lifecycle === 'closed' ? lastEventAt : null,
    archivedAt: null,
  };
}

function harness(input: {
  active?: SessionRecord[];
  dormant?: SessionRecord[];
  history?: HistoryLifecycleCandidate[];
} = {}) {
  let active = [...(input.active ?? [])];
  let dormant = [...(input.dormant ?? [])];
  let history = [...(input.history ?? [])];
  const updated: SessionRecord[] = [];
  const removed: string[] = [];
  const claimed = new Set<string>();
  const sessions: ServerCoreLifecycleRepositoryPort = {
    findActiveExpiring: (threshold, limit) =>
      active.filter((item) => item.lastEventAt < threshold).slice(0, limit),
    findDormantExpiring: (threshold, limit) =>
      dormant.filter((item) => item.lastEventAt < threshold).slice(0, limit),
    batchAdvanceLifecycle: (ids, from, to, at) => {
      const selected = new Set(ids);
      const source = from === 'active' ? active : dormant;
      const changed = source.filter((item) => selected.has(item.id)).map((item) => ({
        ...item,
        lifecycle: to,
        endedAt: to === 'closed' ? at : null,
      }));
      if (from === 'active') {
        active = active.filter((item) => !selected.has(item.id));
        dormant.push(...changed);
      } else {
        dormant = dormant.filter((item) => !selected.has(item.id));
      }
      return changed;
    },
    findHistoryOlderThan: (_threshold, cursor, limit) => {
      const start = cursor === null ? 0 : history.findIndex((item) => item.id === cursor.id) + 1;
      return history.slice(start, start + limit);
    },
    batchDeleteHistory: (candidates) => {
      const ids = new Set(candidates.map((item) => item.id));
      const deleted = history.filter((item) => ids.has(item.id));
      history = history.filter((item) => !ids.has(item.id));
      return deleted;
    },
  };
  const manager = {
    bumpCloseEpoch: vi.fn(),
    forgetCloseEpoch: vi.fn(),
    hasPendingCloseSideEffects: vi.fn(() => false),
    hasSdkClaim: vi.fn((id: string) => claimed.has(id)),
    markRecentlyDeleted: vi.fn(),
    runClosedSideEffects: vi.fn(async () => undefined),
  };
  const lifecycle = new ServerCoreSessionLifecycle({
    sessions,
    manager,
    observer: {
      sessionUpdated: (item) => updated.push(item),
      sessionRemoved: (id) => removed.push(id),
      warning: vi.fn(),
    },
    diagnostics: { info: vi.fn(), warn: vi.fn() },
    activeWindowMs: 1_000,
    closeAfterMs: 2_000,
    historyRetentionDays: 1,
    now: () => 200_000_000,
    intervalMs: 60_000,
    catchUpDelayMs: 1,
  });
  return { claimed, lifecycle, manager, removed, updated };
}

afterEach(() => vi.useRealTimers());

describe('ServerCoreSessionLifecycle', () => {
  it('advances active and dormant rows on startup and publishes authoritative updates', async () => {
    vi.useFakeTimers();
    const state = harness({
      active: [record('active-a', 'active', 199_998_500)],
      dormant: [record('dormant-a', 'dormant')],
    });
    await state.lifecycle.start();

    expect(state.updated).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'active-a', lifecycle: 'dormant' }),
      expect.objectContaining({ id: 'dormant-a', lifecycle: 'closed' }),
    ]));
    expect(state.manager.bumpCloseEpoch).toHaveBeenCalledWith('dormant-a');
    await state.lifecycle.stop('test');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains more than one bounded active batch without an unbounded synchronous scan', async () => {
    vi.useFakeTimers();
    const state = harness({
      active: Array.from({ length: 101 }, (_, index) =>
        record(`active-${index}`, 'active', 199_998_500)),
    });
    await state.lifecycle.start();
    expect(state.updated).toHaveLength(100);
    await vi.runOnlyPendingTimersAsync();
    expect(state.updated).toHaveLength(101);
    await state.lifecycle.stop('test');
  });

  it('does not purge a history identity with an active SDK claim', () => {
    const state = harness({
      history: [
        { id: 'claimed', cliSessionId: 'cli-claimed', lastEventAt: 1 },
        { id: 'purged', cliSessionId: 'cli-purged', lastEventAt: 2 },
      ],
    });
    state.claimed.add('cli-claimed');
    state.lifecycle.scan();

    expect(state.removed).toEqual(['purged']);
    expect(state.manager.markRecentlyDeleted).toHaveBeenCalledWith('purged', 'cli-purged');
  });
});
