/**
 * IssueLifecycleScheduler 测试（plan issue-tracker-mcp-20260529 §Step 3.7.4 / §D13 / §D20）。
 *
 * 覆盖 plan §Step 3.7.4 测试矩阵：
 * - resolved 超期硬删 / 未超期保留
 * - soft-deleted 超期硬删 / 未超期保留
 * - 阈值=0 跳过 GC（两路径独立 0 / 0 / 一边 0 一边非 0）
 * - hardDelete 触发 issue_appendices ON DELETE CASCADE（由 SQLite FK 保证 — 不在 scheduler 内显式调）
 * - **每次 hardDelete 后 emit `eventBus 'issue-changed' kind='hardDeleted' issue: null
 *    sourceSessionId: <snapshot.sourceSessionId>` 一条 event**（R2 MED 加 emit 断言 + R4 codex LOW
 *    加 `sourceSessionId === snapshot.sourceSessionId` 断言钉住 R4 新字段）
 *
 * **测试策略**: mock issueRepo / eventBus；直接调 scheduler.scan() 验业务逻辑（避免 setInterval
 * 异步,scan() 是同步入口的简单调用)。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  issueRepo: {
    listForGc: vi.fn(),
    get: vi.fn(),
    hardDelete: vi.fn(),
  },
  eventBus: { emit: vi.fn() },
}));

vi.mock('@main/store/issue-repo', () => ({ issueRepo: mocks.issueRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));

import { IssueLifecycleScheduler } from '../issue-lifecycle-scheduler';
import type { IssueRecord } from '@shared/types';

const mockIssueRepo = mocks.issueRepo;
const mockEventBus = mocks.eventBus;

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  const now = Date.now();
  return {
    id: 'issue-x',
    title: 'T',
    description: 'D',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'sess-source',
    cwd: null,
    logsRef: null,
    resolutionSessionId: null,
    labels: [],
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockIssueRepo.listForGc.mockReset();
  mockIssueRepo.get.mockReset();
  mockIssueRepo.hardDelete.mockReset().mockReturnValue(true);
  mockEventBus.emit.mockReset();
});

describe('IssueLifecycleScheduler.scan — 阈值 0 跳过 / 超期硬删 / emit kind=hardDeleted', () => {
  it('阈值 0 两路径都跳过 GC: listForGc 返空,不调 hardDelete / 不 emit', () => {
    // 模拟 issueRepo.listForGc 自己处理 0 阈值（已在 Step 3.2 repo test 覆盖）
    // scheduler 层只关心 result.resolvedExpired / softDeletedExpired 数组
    mockIssueRepo.listForGc.mockReturnValue({ resolvedExpired: [], softDeletedExpired: [] });
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 0,
      softDeletedRetentionDays: 0,
    });
    s.scan();
    expect(mockIssueRepo.hardDelete).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('resolved 超期 1 条 → hardDelete + emit kind=hardDeleted issue:null sourceSessionId 取 snapshot 值', () => {
    mockIssueRepo.listForGc.mockReturnValue({
      resolvedExpired: ['issue-resolved-1'],
      softDeletedExpired: [],
    });
    const snapshot = makeIssue({
      id: 'issue-resolved-1',
      status: 'resolved',
      sourceSessionId: 'sess-A',
    });
    mockIssueRepo.get.mockReturnValue(snapshot);
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    expect(mockIssueRepo.hardDelete).toHaveBeenCalledWith('issue-resolved-1');
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({
        kind: 'hardDeleted',
        issueId: 'issue-resolved-1',
        issue: null, // record 已不存在
        sourceSessionId: 'sess-A', // R4 codex LOW: snapshot.sourceSessionId 钉住
      }),
    );
  });

  it('soft-deleted 超期 1 条 → hardDelete + emit kind=hardDeleted sourceSessionId 取 snapshot', () => {
    mockIssueRepo.listForGc.mockReturnValue({
      resolvedExpired: [],
      softDeletedExpired: ['issue-soft-1'],
    });
    const snapshot = makeIssue({ id: 'issue-soft-1', sourceSessionId: 'sess-B', deletedAt: Date.now() - 999 });
    mockIssueRepo.get.mockReturnValue(snapshot);
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    expect(mockIssueRepo.hardDelete).toHaveBeenCalledWith('issue-soft-1');
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({
        kind: 'hardDeleted',
        issueId: 'issue-soft-1',
        sourceSessionId: 'sess-B',
      }),
    );
  });

  it('多条混合 (resolved 2 + soft 1) → 逐条 emit 3 次,每条 sourceSessionId 各自取 snapshot', () => {
    mockIssueRepo.listForGc.mockReturnValue({
      resolvedExpired: ['r1', 'r2'],
      softDeletedExpired: ['s1'],
    });
    mockIssueRepo.get.mockImplementation((id: string) => {
      const map: Record<string, string> = { r1: 'sess-1', r2: 'sess-2', s1: 'sess-3' };
      return makeIssue({ id, sourceSessionId: map[id] });
    });
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    expect(mockIssueRepo.hardDelete).toHaveBeenCalledTimes(3);
    expect(mockEventBus.emit).toHaveBeenCalledTimes(3);
    // 验 3 次 emit 的 sourceSessionId 各自正确（snapshot 钉死）
    const emittedSids = mockEventBus.emit.mock.calls
      .map((c) => (c[1] as { sourceSessionId: string | null }).sourceSessionId);
    expect(emittedSids).toEqual(['sess-1', 'sess-2', 'sess-3']);
  });

  it('snapshot.sourceSessionId === null (orig session 已 GC,FK SET NULL) → emit 仍含 sourceSessionId: null', () => {
    mockIssueRepo.listForGc.mockReturnValue({
      resolvedExpired: ['i1'],
      softDeletedExpired: [],
    });
    mockIssueRepo.get.mockReturnValue(makeIssue({ id: 'i1', sourceSessionId: null }));
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({ kind: 'hardDeleted', issueId: 'i1', sourceSessionId: null }),
    );
  });

  it('snapshot 自己返 null (race: 同时被另一处删) → fallback sourceSessionId: null', () => {
    mockIssueRepo.listForGc.mockReturnValue({
      resolvedExpired: ['ghost-id'],
      softDeletedExpired: [],
    });
    mockIssueRepo.get.mockReturnValue(null);
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    // hardDelete 仍调（race 时是 idempotent）
    expect(mockIssueRepo.hardDelete).toHaveBeenCalledWith('ghost-id');
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({ kind: 'hardDeleted', sourceSessionId: null }),
    );
  });

  it('hardDelete 返 false (race: 已被另一处删) → skip emit', () => {
    mockIssueRepo.listForGc.mockReturnValue({
      resolvedExpired: ['race-id'],
      softDeletedExpired: [],
    });
    mockIssueRepo.get.mockReturnValue(makeIssue({ id: 'race-id' }));
    mockIssueRepo.hardDelete.mockReturnValue(false);
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('单条 hardDelete throw → console.warn,后续条目仍继续不中断', () => {
    mockIssueRepo.listForGc.mockReturnValue({
      resolvedExpired: ['fail-id', 'ok-id'],
      softDeletedExpired: [],
    });
    mockIssueRepo.get.mockImplementation((id: string) => makeIssue({ id, sourceSessionId: 'sess-x' }));
    mockIssueRepo.hardDelete.mockImplementation((id: string) => {
      if (id === 'fail-id') throw new Error('SQLite locked');
      return true;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    // 'ok-id' 仍被删 + emit
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({ issueId: 'ok-id' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/hardDelete fail-id failed/),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe('IssueLifecycleScheduler.updateThresholds — 热更新 (settings.ts applyIssueGcThresholds 用)', () => {
  it('updateThresholds 改 resolvedRetentionDays 后立即生效（下次 scan 用新值传给 listForGc）', () => {
    mockIssueRepo.listForGc.mockReturnValue({ resolvedExpired: [], softDeletedExpired: [] });
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.scan();
    expect(mockIssueRepo.listForGc).toHaveBeenCalledWith({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
    });
    s.updateThresholds({ resolvedRetentionDays: 30 });
    s.scan();
    expect(mockIssueRepo.listForGc).toHaveBeenLastCalledWith({
      resolvedRetentionDays: 30, // 热更新
      softDeletedRetentionDays: 7, // 未传字段保留
    });
  });
});

describe('IssueLifecycleScheduler.start/stop — setInterval lifecycle', () => {
  it('start() 启动 setInterval + 立即跑一次 tick (避免首次 wait 6h)', () => {
    vi.useFakeTimers();
    mockIssueRepo.listForGc.mockReturnValue({ resolvedExpired: [], softDeletedExpired: [] });
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
      tickIntervalMs: 100,
    });
    s.start();
    // 立即跑一次
    expect(mockIssueRepo.listForGc).toHaveBeenCalledTimes(1);
    // setInterval tick 后再跑一次
    vi.advanceTimersByTime(100);
    expect(mockIssueRepo.listForGc).toHaveBeenCalledTimes(2);
    s.stop();
    vi.advanceTimersByTime(100);
    // stop 后不再 tick
    expect(mockIssueRepo.listForGc).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('start() 重复调用是 idempotent（不起多个 setInterval）', () => {
    vi.useFakeTimers();
    mockIssueRepo.listForGc.mockReturnValue({ resolvedExpired: [], softDeletedExpired: [] });
    const s = new IssueLifecycleScheduler({
      resolvedRetentionDays: 90,
      softDeletedRetentionDays: 7,
      tickIntervalMs: 100,
    });
    s.start();
    s.start(); // 第二次调用应 no-op（不起第二个 setInterval）
    expect(mockIssueRepo.listForGc).toHaveBeenCalledTimes(1); // 仅第一次 start 立即跑
    vi.advanceTimersByTime(100);
    expect(mockIssueRepo.listForGc).toHaveBeenCalledTimes(2); // 仅一个 setInterval tick
    s.stop();
    vi.useRealTimers();
  });
});
