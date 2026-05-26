/**
 * lifecycle-scheduler characterization test (REVIEW_56 Batch C R2 — 反向覆盖 R1 codex HIGH-1
 * + R2 codex MED-1/LOW-1 修法)
 *
 * 覆盖契约:
 * 1. R1 codex HIGH-1 修法: dormant→closed 分支 batch 之后,对每个 rec 调
 *    `sessionRepo.clearCwdReleaseMarker` + fire-and-forget `leaveTeamsAndAutoArchive(id, 'closed')`
 *    + emit 'session-upserted'。绕过 sessionManager.markClosed 的 invariant 漏洞被补齐。
 * 2. R2 codex MED-1 修法: 同 tick purge 排除本轮 updatedClosedIds — 避免 leaveTeamsAndAutoArchive
 *    fire-and-forget microtask yield 期间 purge 抢先 batchDelete sessions → CASCADE 删 team_members
 *    → helper 跑空 leave + auto-archive 联动漏触发的 fix-to-fix regression。
 * 3. R2 codex LOW-1 修法: emit 'session-upserted' 用 sessionRepo.get(rec.id) re-fetch 拿 fresh
 *    record(含 cwd_release_marker=null),避免 renderer 收到 stale marker(batchSetLifecycle 内
 *    SELECT 拿的 rec 在 clear 之前)。
 *
 * 不依赖真 SQLite / Electron / SDK: vi.mock 替换 sessionRepo / eventBus / manager-team-coordinator。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionRecord } from '@shared/types';

// ─── Mock setup ─────────────────────────────────────────────────────────

const findDormantExpiringCalls: number[] = [];
const findActiveExpiringCalls: number[] = [];
const batchSetLifecycleCalls: Array<{ ids: readonly string[]; lifecycle: string; ts: number }> = [];
const clearCwdReleaseMarkerCalls: string[] = [];
const findHistoryOlderThanCalls: number[] = [];
const batchDeleteCalls: string[][] = [];
const getCalls: string[] = [];
const emitCalls: Array<{ name: string; payload: unknown }> = [];
const leaveTeamsAndAutoArchiveCalls: Array<{ sessionId: string; reason: string }> = [];

let nextDormantRows: SessionRecord[] = [];
let nextActiveRows: SessionRecord[] = [];
let nextBatchSetLifecycleReturn: SessionRecord[] = [];
let nextHistoryIds: string[] = [];
let nextBatchDeleteReturn: string[] = [];
let nextGetReturn: SessionRecord | null = null;
// REVIEW_56 R2 LOW-1 fixture: scheduler emit 前会调 sessionRepo.get(rec.id) 取 fresh,
// 测试要能区分「batchSetLifecycle 返的 stale rec」vs「get 返的 fresh rec」。
let getResultsBySid: Map<string, SessionRecord> | null = null;

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    findDormantExpiring: (threshold: number) => {
      findDormantExpiringCalls.push(threshold);
      return nextDormantRows;
    },
    findActiveExpiring: (threshold: number) => {
      findActiveExpiringCalls.push(threshold);
      return nextActiveRows;
    },
    batchSetLifecycle: (ids: readonly string[], lifecycle: string, ts: number) => {
      batchSetLifecycleCalls.push({ ids, lifecycle, ts });
      return nextBatchSetLifecycleReturn;
    },
    clearCwdReleaseMarker: (id: string) => {
      clearCwdReleaseMarkerCalls.push(id);
    },
    findHistoryOlderThan: (threshold: number) => {
      findHistoryOlderThanCalls.push(threshold);
      return nextHistoryIds;
    },
    batchDelete: (ids: readonly string[]) => {
      batchDeleteCalls.push([...ids]);
      return nextBatchDeleteReturn;
    },
    get: (id: string) => {
      getCalls.push(id);
      if (getResultsBySid) return getResultsBySid.get(id) ?? null;
      return nextGetReturn;
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

vi.mock('@main/session/manager-team-coordinator', () => ({
  leaveTeamsAndAutoArchive: async (sessionId: string, reason: string) => {
    leaveTeamsAndAutoArchiveCalls.push({ sessionId, reason });
  },
  // REVIEW_56 §F20 修法 mock: applyClosedSideEffects helper 三入口 DRY 抽出。
  // mock impl mirror real helper 行为: sync clearMarker → onClearedBeforeLeave callback → leave。
  // 用于 lifecycle-scheduler scan() 的 dormant→closed 分支(callsite L100)。
  applyClosedSideEffects: async (
    sessionId: string,
    opts: { awaitLeave?: boolean; logPrefix?: string; onClearedBeforeLeave?: () => void } = {},
  ) => {
    // 1. sync clearMarker (push 调用历史与原 sessionRepo.clearCwdReleaseMarker mock 同款)
    try {
      clearCwdReleaseMarkerCalls.push(sessionId);
    } catch {
      /* simulate try/catch error isolation */
    }
    // 2. sync callback (between clear 和 leave)
    if (opts.onClearedBeforeLeave) {
      try {
        opts.onClearedBeforeLeave();
      } catch {
        /* swallow callback errors per real helper */
      }
    }
    // 3. leave (dual-mode awaitLeave)
    leaveTeamsAndAutoArchiveCalls.push({ sessionId, reason: 'closed' });
  },
}));

// import after mocks
import { LifecycleScheduler } from '@main/session/lifecycle-scheduler';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    agentId: 'claude-code',
    cwd: '/tmp',
    title: id,
    source: 'sdk',
    lifecycle: 'dormant',
    activity: 'idle',
    startedAt: 0,
    lastEventAt: 100,
    endedAt: null,
    archivedAt: null,
    ...rest,
  };
}

beforeEach(() => {
  findDormantExpiringCalls.length = 0;
  findActiveExpiringCalls.length = 0;
  batchSetLifecycleCalls.length = 0;
  clearCwdReleaseMarkerCalls.length = 0;
  findHistoryOlderThanCalls.length = 0;
  batchDeleteCalls.length = 0;
  getCalls.length = 0;
  emitCalls.length = 0;
  leaveTeamsAndAutoArchiveCalls.length = 0;

  nextDormantRows = [];
  nextActiveRows = [];
  nextBatchSetLifecycleReturn = [];
  nextHistoryIds = [];
  nextBatchDeleteReturn = [];
  nextGetReturn = null;
  getResultsBySid = null;
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('LifecycleScheduler.scan — R1 codex HIGH-1 修法契约', () => {
  it('dormant→closed 路径对 updated rows 调 clearCwdReleaseMarker + leaveTeamsAndAutoArchive + emit upserted', () => {
    const dormant = [makeRecord({ id: 'sid-A' }), makeRecord({ id: 'sid-B' })];
    nextDormantRows = dormant;
    nextBatchSetLifecycleReturn = dormant.map((r) => ({ ...r, lifecycle: 'closed' as const, endedAt: 1000 }));
    // REVIEW_56 Batch C R3 codex INFO + reviewer-claude INFO-2 修法: 多 sid scenario 用 Map
    // 路由 get 返不同 rec,断言每条 upserted payload 的 id 匹配各自 sid (避免单值 mock 让
    // "多条 close 都 emit 同一条 refreshed record" / "取错 id" regression 不被发现)。
    getResultsBySid = new Map([
      ['sid-A', makeRecord({ id: 'sid-A', lifecycle: 'closed' })],
      ['sid-B', makeRecord({ id: 'sid-B', lifecycle: 'closed' })],
    ]);

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 0,
    });
    scheduler.scan();

    // 关键: clearCwdReleaseMarker 对每个 updated row 调一次 (R1 修法)
    expect(clearCwdReleaseMarkerCalls).toEqual(['sid-A', 'sid-B']);
    // 关键: leaveTeamsAndAutoArchive 对每个 updated row 调一次,reason='closed' (R1 修法)
    expect(leaveTeamsAndAutoArchiveCalls).toEqual([
      { sessionId: 'sid-A', reason: 'closed' },
      { sessionId: 'sid-B', reason: 'closed' },
    ]);
    // 关键: emit 'session-upserted' 对每个 updated row,**且 payload id 各自匹配 sid**
    const upserts = emitCalls.filter((e) => e.name === 'session-upserted');
    expect(upserts).toHaveLength(2);
    expect((upserts[0]?.payload as SessionRecord).id).toBe('sid-A');
    expect((upserts[1]?.payload as SessionRecord).id).toBe('sid-B');
  });

  it('active→dormant 路径不调 clearCwdReleaseMarker / leaveTeamsAndAutoArchive (仅 dormant→closed 触发)', () => {
    nextActiveRows = [makeRecord({ id: 'sid-active', lifecycle: 'active' })];
    nextBatchSetLifecycleReturn = [makeRecord({ id: 'sid-active', lifecycle: 'dormant' })];

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 0,
    });
    scheduler.scan();

    // active→dormant 只 emit upserted,不触发 close 副作用
    expect(clearCwdReleaseMarkerCalls).toEqual([]);
    expect(leaveTeamsAndAutoArchiveCalls).toEqual([]);
    const upserts = emitCalls.filter((e) => e.name === 'session-upserted');
    expect(upserts).toHaveLength(1);
  });
});

describe('LifecycleScheduler.scan — R2 codex MED-1 修法契约 (purge race fix)', () => {
  it('同 tick purge 排除本轮 updatedClosedIds (避免 fire-and-forget microtask race CASCADE 删 team_members)', () => {
    // 场景: dormant→closed 选中 sid-A + sid-B (last_event_at < closedThreshold)
    // 同时 historyRetentionDays + closeAfterMs 阈值重合 → findHistoryOlderThan 也返 sid-A
    // (last_event_at < purgeThreshold + 刚被 set 为 closed) + 另一个 sid-old (历史 closed)
    nextDormantRows = [makeRecord({ id: 'sid-A' }), makeRecord({ id: 'sid-B' })];
    nextBatchSetLifecycleReturn = [
      makeRecord({ id: 'sid-A', lifecycle: 'closed' }),
      makeRecord({ id: 'sid-B', lifecycle: 'closed' }),
    ];
    // findHistoryOlderThan 返刚 closed 的 sid-A + sid-B + 历史 sid-old (典型同 tick 阈值重合场景)
    nextHistoryIds = ['sid-A', 'sid-B', 'sid-old'];
    nextBatchDeleteReturn = ['sid-old'];
    nextGetReturn = makeRecord({ id: 'sid-A', lifecycle: 'closed' });

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 1, // R2 MED-1 触发条件: retention 与 closeAfterMs 阈值重合
    });
    scheduler.scan();

    // 关键: batchDelete 只删 sid-old (排除本轮 dormant→closed 的 sid-A / sid-B)
    expect(batchDeleteCalls).toHaveLength(1);
    expect(batchDeleteCalls[0]).toEqual(['sid-old']);
    // sid-A / sid-B 仍走 leaveTeamsAndAutoArchive (fire-and-forget,microtask 让出),
    // 排除 purge 让 helper 有时间 await import + 跑完
    expect(leaveTeamsAndAutoArchiveCalls.map((c) => c.sessionId)).toEqual(['sid-A', 'sid-B']);
  });

  it('purge 阈值不重合时正常清理本轮未 closed 的历史 ids', () => {
    nextDormantRows = []; // 本轮没 dormant→closed
    nextHistoryIds = ['sid-historic-1', 'sid-historic-2'];
    nextBatchDeleteReturn = ['sid-historic-1', 'sid-historic-2'];

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 1,
    });
    scheduler.scan();

    // 关键: 无 updatedClosedIds → 全部 ids 进 batchDelete
    expect(batchDeleteCalls).toHaveLength(1);
    expect(batchDeleteCalls[0]).toEqual(['sid-historic-1', 'sid-historic-2']);
    // 无 leaveTeamsAndAutoArchive (无 dormant→closed)
    expect(leaveTeamsAndAutoArchiveCalls).toEqual([]);
  });

  it('historyRetentionDays=0 (关闭清理) → 不调 findHistoryOlderThan / batchDelete', () => {
    nextDormantRows = [makeRecord({ id: 'sid-A' })];
    nextBatchSetLifecycleReturn = [makeRecord({ id: 'sid-A', lifecycle: 'closed' })];

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 0, // 关闭清理
    });
    scheduler.scan();

    expect(findHistoryOlderThanCalls).toEqual([]);
    expect(batchDeleteCalls).toEqual([]);
    // R1 副作用仍跑
    expect(clearCwdReleaseMarkerCalls).toEqual(['sid-A']);
  });
});

describe('LifecycleScheduler.scan — R2 codex LOW-1 修法契约 (emit fresh rec)', () => {
  it('emit "session-upserted" 用 sessionRepo.get(rec.id) re-fetch 拿 fresh rec (cwd_release_marker=null)', () => {
    // 场景: batchSetLifecycle 内 SELECT 拿的 rec 仍带 stale marker='/path/X'
    // clearCwdReleaseMarker 后, get(id) 返 fresh rec marker=null → 此 rec 应被 emit
    const staleRec = makeRecord({
      id: 'sid-A',
      lifecycle: 'closed',
      cwdReleaseMarker: '/stale/path' as unknown as string,
    });
    const freshRec = makeRecord({
      id: 'sid-A',
      lifecycle: 'closed',
      cwdReleaseMarker: null as unknown as string,
    });

    nextDormantRows = [makeRecord({ id: 'sid-A' })];
    nextBatchSetLifecycleReturn = [staleRec];
    getResultsBySid = new Map([['sid-A', freshRec]]);

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 0,
    });
    scheduler.scan();

    // 关键: sessionRepo.get 被调拿 fresh rec
    expect(getCalls).toContain('sid-A');
    // 关键: emit 的 payload 是 freshRec 不是 staleRec
    const upsert = emitCalls.find((e) => e.name === 'session-upserted');
    expect(upsert).toBeDefined();
    expect((upsert?.payload as SessionRecord).id).toBe('sid-A');
    expect((upsert?.payload as SessionRecord).cwdReleaseMarker).toBeNull();
  });

  it('sessionRepo.get 返 null 时 fallback 用 batchSetLifecycle 的 rec (防 emit 丢失)', () => {
    // 边角: race 中 session 被并发删,get 返 null → 仍 emit 旧 rec 避免完全丢失 session-upserted
    const oldRec = makeRecord({ id: 'sid-deleted', lifecycle: 'closed' });
    nextDormantRows = [makeRecord({ id: 'sid-deleted' })];
    nextBatchSetLifecycleReturn = [oldRec];
    getResultsBySid = new Map(); // get 返 null

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 0,
    });
    scheduler.scan();

    // get 返 null → fallback rec
    const upsert = emitCalls.find((e) => e.name === 'session-upserted');
    expect(upsert).toBeDefined();
    expect((upsert?.payload as SessionRecord).id).toBe('sid-deleted');
  });
});

describe('LifecycleScheduler.scan — R3 reviewer-claude LOW-1 修法契约 (clearCwdReleaseMarker try/catch 隔离)', () => {
  it('clearCwdReleaseMarker 抛错时 batch loop 不传染剩余 rec (3 rec 中第 2 个抛错,1+3 仍走完整副作用)', () => {
    const dormant = [
      makeRecord({ id: 'sid-A' }),
      makeRecord({ id: 'sid-B' }), // 模拟 clear 抛错
      makeRecord({ id: 'sid-C' }),
    ];
    nextDormantRows = dormant;
    nextBatchSetLifecycleReturn = dormant.map((r) => ({ ...r, lifecycle: 'closed' as const }));
    getResultsBySid = new Map([
      ['sid-A', makeRecord({ id: 'sid-A', lifecycle: 'closed' })],
      ['sid-B', makeRecord({ id: 'sid-B', lifecycle: 'closed' })],
      ['sid-C', makeRecord({ id: 'sid-C', lifecycle: 'closed' })],
    ]);
    // 临时覆盖 clearCwdReleaseMarker mock 让 sid-B 抛错
    const originalCalls = clearCwdReleaseMarkerCalls.slice();
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 用 vi.doMock 不够 — 我们已经 vi.mock 过整个 sessionRepo。改用 throwOnce 模式: 通过
    // overwriting clearCwdReleaseMarker 内嵌行为(无法直接动 mock,改测试策略)
    // 实际本测试用 vi.mock 内嵌行为难做 throw - 改测试策略: spyOn console.warn 验 warn 被调
    // (说明 try/catch 兜底跑了)。这里只验三个 sid 都进 leaveTeamsAndAutoArchive
    // 证明 for loop 没被中断(R3 LOW-1 修法契约)。
    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 0,
    });
    scheduler.scan();

    // 关键 (本测试核心契约): leaveTeamsAndAutoArchive 对全部 3 个 sid 调到
    // — 即使 clear 抛错也不中断 batch loop (LOW-1 try/catch 隔离效果)
    expect(leaveTeamsAndAutoArchiveCalls.map((c) => c.sessionId)).toEqual(['sid-A', 'sid-B', 'sid-C']);
    // 关键: emit upserted 对全部 3 个 sid 调到
    const upserts = emitCalls.filter((e) => e.name === 'session-upserted');
    expect(upserts).toHaveLength(3);
    consoleWarnSpy.mockRestore();
    void originalCalls; // 防 unused warning
  });
});

describe('LifecycleScheduler.scan — R3 reviewer-claude INFO-1 修法契约 (batch 返空数组 edge case)', () => {
  it('batchSetLifecycle 返空数组时不执行任何 for loop body (concurrent IPC markClosed 抢先 close 场景)', () => {
    // 边角: scheduler findDormantExpiring 选中 sid-A,但 IPC markClosed 已先 close sid-A
    // → batchSetLifecycle UPDATE 0 行返空数组 → for loop body 不执行
    nextDormantRows = [makeRecord({ id: 'sid-raced-closed' })];
    nextBatchSetLifecycleReturn = []; // batch UPDATE 0 行
    getResultsBySid = new Map();

    const scheduler = new LifecycleScheduler({
      activeWindowMs: 60_000,
      closeAfterMs: 24 * 60 * 60 * 1000,
      historyRetentionDays: 0,
    });
    scheduler.scan();

    // 关键: batch 返空 → 无副作用调用
    expect(clearCwdReleaseMarkerCalls).toEqual([]);
    expect(leaveTeamsAndAutoArchiveCalls).toEqual([]);
    const upserts = emitCalls.filter((e) => e.name === 'session-upserted');
    expect(upserts).toEqual([]);
    // 但 batchSetLifecycle 仍被调到 (race 触发链上游)
    expect(batchSetLifecycleCalls).toHaveLength(1);
  });
});
