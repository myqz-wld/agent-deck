/**
 * TokenUsageLifecycleScheduler tests.
 *
 * Covers the fixed 365d retention policy, single refresh event after deletion,
 * failure isolation, singleton holder, and start/stop timer lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import log from 'electron-log/main';

const mocks = vi.hoisted(() => ({
  repo: {
    deleteOlderThan: vi.fn(),
  },
  eventBus: { emit: vi.fn() },
}));

vi.mock('@main/store/token-usage-repo', () => ({
  tokenUsageRepo: mocks.repo,
}));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));

import {
  getTokenUsageLifecycleScheduler,
  setTokenUsageLifecycleScheduler,
  TOKEN_USAGE_GC_BATCH_LIMIT,
  TOKEN_USAGE_RETENTION_DAYS,
  TokenUsageLifecycleScheduler,
} from '../token-usage-lifecycle-scheduler';

const mockRepo = mocks.repo;
const mockEventBus = mocks.eventBus;
const tokenUsageGcLogger = log.scope('token-usage-gc');

beforeEach(() => {
  mockRepo.deleteOlderThan.mockReset().mockReturnValue(0);
  mockEventBus.emit.mockReset();
  (tokenUsageGcLogger.warn as ReturnType<typeof vi.fn>).mockClear();
  (tokenUsageGcLogger.info as ReturnType<typeof vi.fn>).mockClear();
  setTokenUsageLifecycleScheduler(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setTokenUsageLifecycleScheduler(null);
});

describe('TokenUsageLifecycleScheduler.scan', () => {
  it('deletes token_usage rows older than fixed 365d threshold', () => {
    const now = Date.UTC(2026, 5, 11);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const s = new TokenUsageLifecycleScheduler();

    s.scan();

    expect(mockRepo.deleteOlderThan).toHaveBeenCalledWith(
      now - TOKEN_USAGE_RETENTION_DAYS * 86_400_000,
    );
  });

  it('emits one token-usage-changed event only when rows were deleted', () => {
    const now = Date.UTC(2026, 5, 11);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mockRepo.deleteOlderThan.mockReturnValue(3);
    const s = new TokenUsageLifecycleScheduler();

    s.scan();

    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emit).toHaveBeenCalledWith('token-usage-changed', {
      sessionId: 'gc',
      ts: now,
    });
    expect(tokenUsageGcLogger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'token-usage-retention',
        changed: 3,
        outcome: 'success',
      }),
    );
  });

  it('does not emit when no rows were deleted', () => {
    const s = new TokenUsageLifecycleScheduler();

    s.scan();

    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('logs and isolates delete failures', () => {
    mockRepo.deleteOlderThan.mockImplementation(() => {
      throw new Error('SQLite locked');
    });
    const s = new TokenUsageLifecycleScheduler();

    expect(() => s.scan()).not.toThrow();

    expect(mockEventBus.emit).not.toHaveBeenCalled();
    expect(tokenUsageGcLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'token-usage-retention',
        changed: 0,
        outcome: 'failed',
      }),
    );
  });

  it('drains a 1001-row backlog as 500 → 500 → 1 and then stops', () => {
    vi.useFakeTimers();
    mockRepo.deleteOlderThan
      .mockReturnValueOnce(TOKEN_USAGE_GC_BATCH_LIMIT)
      .mockReturnValueOnce(TOKEN_USAGE_GC_BATCH_LIMIT)
      .mockReturnValueOnce(1);
    const s = new TokenUsageLifecycleScheduler({ catchUpDelayMs: 50 });

    s.scan();
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(50);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(3);
    expect(mockEventBus.emit).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(500);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(3);
  });

  it('continues through consecutive full batches without duplicate timers', () => {
    vi.useFakeTimers();
    mockRepo.deleteOlderThan
      .mockReturnValueOnce(TOKEN_USAGE_GC_BATCH_LIMIT)
      .mockReturnValueOnce(TOKEN_USAGE_GC_BATCH_LIMIT)
      .mockReturnValueOnce(TOKEN_USAGE_GC_BATCH_LIMIT)
      .mockReturnValueOnce(2);
    const s = new TokenUsageLifecycleScheduler({ catchUpDelayMs: 50 });

    s.scan();
    vi.advanceTimersByTime(150);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(500);

    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(4);
  });

  it('ignores reentrant and overlapping scans while one catch-up chain owns scheduling', () => {
    vi.useFakeTimers();
    let s: TokenUsageLifecycleScheduler;
    mockRepo.deleteOlderThan
      .mockImplementationOnce(() => {
        s.scan();
        return TOKEN_USAGE_GC_BATCH_LIMIT;
      })
      .mockReturnValueOnce(1);
    s = new TokenUsageLifecycleScheduler({ catchUpDelayMs: 50 });

    s.scan();
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(1);
    s.scan();
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
  });

  it('stops a catch-up chain after zero progress and recovers on the next interval', () => {
    vi.useFakeTimers();
    mockRepo.deleteOlderThan
      .mockReturnValueOnce(TOKEN_USAGE_GC_BATCH_LIMIT)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    const s = new TokenUsageLifecycleScheduler({
      tickIntervalMs: 200,
      catchUpDelayMs: 50,
    });

    s.start();
    vi.advanceTimersByTime(50);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(149);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(3);
    s.stop();
  });

  it('stops a catch-up chain after a batch failure and recovers on the next interval', () => {
    vi.useFakeTimers();
    mockRepo.deleteOlderThan
      .mockReturnValueOnce(TOKEN_USAGE_GC_BATCH_LIMIT)
      .mockImplementationOnce(() => {
        throw new Error('SQLite locked');
      })
      .mockReturnValueOnce(1);
    const s = new TokenUsageLifecycleScheduler({
      tickIntervalMs: 200,
      catchUpDelayMs: 50,
    });

    s.start();
    vi.advanceTimersByTime(50);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(149);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(3);
    expect(tokenUsageGcLogger.warn).toHaveBeenCalledTimes(1);
    s.stop();
  });
});

describe('TokenUsageLifecycleScheduler.start/stop', () => {
  it('starts with an immediate scan and stops future interval ticks', () => {
    vi.useFakeTimers();
    const s = new TokenUsageLifecycleScheduler({ tickIntervalMs: 100 });

    s.start();
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);

    s.stop();
    vi.advanceTimersByTime(100);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
  });

  it('start is idempotent', () => {
    vi.useFakeTimers();
    const s = new TokenUsageLifecycleScheduler({ tickIntervalMs: 100 });

    s.start();
    s.start();
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);

    s.stop();
  });

  it('survives a locked query and runs the next interval tick', () => {
    vi.useFakeTimers();
    mockRepo.deleteOlderThan
      .mockImplementationOnce(() => {
        throw new Error('SQLite locked');
      })
      .mockReturnValueOnce(1);
    const s = new TokenUsageLifecycleScheduler({ tickIntervalMs: 100 });

    expect(() => s.start()).not.toThrow();
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('stop clears the interval and a pending timer in the middle of a catch-up chain', () => {
    vi.useFakeTimers();
    mockRepo.deleteOlderThan.mockReturnValue(TOKEN_USAGE_GC_BATCH_LIMIT);
    const s = new TokenUsageLifecycleScheduler({
      tickIntervalMs: 100,
      catchUpDelayMs: 50,
    });

    s.start();
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
    s.stop();
    vi.advanceTimersByTime(500);

    expect(mockRepo.deleteOlderThan).toHaveBeenCalledTimes(2);
  });
});

describe('TokenUsageLifecycleScheduler singleton holder', () => {
  it('stores and clears the active scheduler', () => {
    const s = new TokenUsageLifecycleScheduler();

    setTokenUsageLifecycleScheduler(s);
    expect(getTokenUsageLifecycleScheduler()).toBe(s);

    setTokenUsageLifecycleScheduler(null);
    expect(getTokenUsageLifecycleScheduler()).toBeNull();
  });
});
