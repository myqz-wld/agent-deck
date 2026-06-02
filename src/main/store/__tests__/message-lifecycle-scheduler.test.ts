/**
 * MessageLifecycleScheduler 测试（plan message-retention-and-index-20260602 §Step 7）。
 *
 * 覆盖：
 * - messageRetentionDays=0 跳过 GC（scan 早退，不调 listExpiredForGc / batchHardDelete / 不 emit）
 * - 超期 terminal 删 → emit 一次 agent-deck-message-purged { count }
 * - deletedCount>0 才 emit；deletedCount=0（全 race）不 emit
 * - 删满 limit + deletedCount>0 → 调度 catch-up 续删；deletedCount=0 不排（防空转）；删 < limit 不排
 * - stop() 清 catch-up timer
 * - updateThresholds 热更新（settings.ts applyMessageGcThreshold 用）
 * - start/stop setInterval lifecycle + idempotent
 * - scan throw（DB 锁）不崩 tick
 *
 * 测试策略：mock agentDeckMessageRepo / eventBus；直接调 scan() 验业务逻辑（避免 setInterval 异步）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  repo: {
    listExpiredForGc: vi.fn(),
    batchHardDelete: vi.fn(),
  },
  eventBus: { emit: vi.fn() },
}));

// scheduler 从 facade import agentDeckMessageRepo + GC_BATCH_LIMIT（后者作 DEFAULT_GC_BATCH_LIMIT
// SSOT，impl-review INFO-1）。mock 必须同时提供两者，否则模块加载时 GC_BATCH_LIMIT=undefined。
vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: mocks.repo,
  GC_BATCH_LIMIT: 500,
}));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));

import { MessageLifecycleScheduler } from '../message-lifecycle-scheduler';

const mockRepo = mocks.repo;
const mockEventBus = mocks.eventBus;

beforeEach(() => {
  mockRepo.listExpiredForGc.mockReset();
  // 默认 batchHardDelete 原样返回传入 ids（全部成功删）
  mockRepo.batchHardDelete.mockReset().mockImplementation((ids: readonly string[]) => [...ids]);
  mockEventBus.emit.mockReset();
});

describe('MessageLifecycleScheduler.scan — 阈值 0 跳过 / 超期删 / emit purged', () => {
  it('messageRetentionDays=0 → scan 早退：不调 listExpiredForGc / batchHardDelete / 不 emit', () => {
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 0 });
    s.scan();
    expect(mockRepo.listExpiredForGc).not.toHaveBeenCalled();
    expect(mockRepo.batchHardDelete).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('超期 terminal 3 条 → batchHardDelete + emit 一次 agent-deck-message-purged { count: 3 }', () => {
    mockRepo.listExpiredForGc.mockReturnValue(['m1', 'm2', 'm3']);
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30 });
    s.scan();
    expect(mockRepo.batchHardDelete).toHaveBeenCalledWith(['m1', 'm2', 'm3']);
    // 单次 emit（非逐条）{ count }
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emit).toHaveBeenCalledWith('agent-deck-message-purged', { count: 3 });
  });

  it('listExpiredForGc 传 retentionDays + limit（默认 500）', () => {
    mockRepo.listExpiredForGc.mockReturnValue([]);
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30 });
    s.scan();
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 30, limit: 500 }),
    );
  });

  it('无超期消息（listExpiredForGc 返空）→ 不调 batchHardDelete / 不 emit', () => {
    mockRepo.listExpiredForGc.mockReturnValue([]);
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30 });
    s.scan();
    expect(mockRepo.batchHardDelete).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('deletedCount=0（batchHardDelete 全 race 返空）→ 不 emit', () => {
    mockRepo.listExpiredForGc.mockReturnValue(['m1', 'm2']);
    mockRepo.batchHardDelete.mockReturnValue([]); // 全 race，真删 0
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30 });
    s.scan();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('scan throw（DB 锁）→ console.warn 不崩，不 emit', () => {
    mockRepo.listExpiredForGc.mockImplementation(() => {
      throw new Error('SQLite locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30 });
    expect(() => s.scan()).not.toThrow();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/message-gc.*scan failed/),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe('MessageLifecycleScheduler.scan — catch-up 续删节奏', () => {
  it('删满 limit（=积压）+ deletedCount>0 → 调度短延迟续删；续删轮删 < limit 后停', () => {
    vi.useFakeTimers();
    let round = 0;
    mockRepo.listExpiredForGc.mockImplementation(() => {
      round++;
      if (round === 1) return ['a', 'b']; // 删满 limit=2
      if (round === 2) return ['c']; // < limit 清完
      return [];
    });
    const s = new MessageLifecycleScheduler({
      messageRetentionDays: 30,
      gcBatchLimit: 2,
      catchUpDelayMs: 30_000,
    });
    s.scan(); // 第一轮删满 → 排续删
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1);
    expect(mockRepo.batchHardDelete).toHaveBeenCalledTimes(1);
    // 30s 后续删 tick fire
    vi.advanceTimersByTime(30_000);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(2);
    expect(mockRepo.batchHardDelete).toHaveBeenCalledTimes(2);
    // 第二轮 < limit → 不再排，30s 后无新 scan
    vi.advanceTimersByTime(30_000);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('删 < limit（无积压）→ 不排续删', () => {
    vi.useFakeTimers();
    mockRepo.listExpiredForGc.mockReturnValue(['only1']);
    const s = new MessageLifecycleScheduler({
      messageRetentionDays: 30,
      gcBatchLimit: 500,
      catchUpDelayMs: 30_000,
    });
    s.scan();
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1); // 无续删
    vi.useRealTimers();
  });

  it('删满 limit 但 deletedCount=0（全 race）→ 不排续删（防空转死循环）', () => {
    vi.useFakeTimers();
    mockRepo.listExpiredForGc.mockReturnValue(['g1', 'g2']);
    mockRepo.batchHardDelete.mockReturnValue([]); // 全 race → deletedCount=0
    const s = new MessageLifecycleScheduler({
      messageRetentionDays: 30,
      gcBatchLimit: 2,
      catchUpDelayMs: 30_000,
    });
    s.scan();
    vi.advanceTimersByTime(60_000);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1); // 不排续删
    vi.useRealTimers();
  });

  it('stop() 清 pending 续删 timer → 续删 tick 不再 fire', () => {
    vi.useFakeTimers();
    mockRepo.listExpiredForGc.mockReturnValue(['a', 'b']);
    const s = new MessageLifecycleScheduler({
      messageRetentionDays: 30,
      gcBatchLimit: 2,
      catchUpDelayMs: 30_000,
    });
    s.scan(); // 删满 → 排续删
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1);
    s.stop(); // 清 pending 续删 timer
    vi.advanceTimersByTime(60_000);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1); // 续删被取消
    vi.useRealTimers();
  });
});

describe('MessageLifecycleScheduler.updateThresholds — 热更新（settings.ts applyMessageGcThreshold 用）', () => {
  it('updateThresholds 改 messageRetentionDays 后下次 scan 用新值', () => {
    mockRepo.listExpiredForGc.mockReturnValue([]);
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30 });
    s.scan();
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 30 }),
    );
    s.updateThresholds({ messageRetentionDays: 7 });
    s.scan();
    expect(mockRepo.listExpiredForGc).toHaveBeenLastCalledWith(
      expect.objectContaining({ retentionDays: 7 }),
    );
  });

  it('updateThresholds 改成 0 → scan 早退停止 GC（即改即生效关闭）', () => {
    mockRepo.listExpiredForGc.mockReturnValue([]);
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30 });
    s.scan();
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1);
    s.updateThresholds({ messageRetentionDays: 0 });
    s.scan();
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1); // 0 早退，不再调
  });
});

describe('MessageLifecycleScheduler.start/stop — setInterval lifecycle', () => {
  it('start() 启动 setInterval + 立即跑一次 tick（避免首次 wait 6h）', () => {
    vi.useFakeTimers();
    mockRepo.listExpiredForGc.mockReturnValue([]);
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30, tickIntervalMs: 100 });
    s.start();
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(2);
    s.stop();
    vi.advanceTimersByTime(100);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(2); // stop 后不再 tick
    vi.useRealTimers();
  });

  it('start() 重复调用 idempotent（不起多个 setInterval）', () => {
    vi.useFakeTimers();
    mockRepo.listExpiredForGc.mockReturnValue([]);
    const s = new MessageLifecycleScheduler({ messageRetentionDays: 30, tickIntervalMs: 100 });
    s.start();
    s.start(); // no-op
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(mockRepo.listExpiredForGc).toHaveBeenCalledTimes(2); // 仅一个 setInterval tick
    s.stop();
    vi.useRealTimers();
  });
});
