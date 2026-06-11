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
      expect.stringContaining('[token-usage-gc] purged expired token_usage rows'),
      expect.objectContaining({ deletedCount: 3, retentionDays: TOKEN_USAGE_RETENTION_DAYS }),
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
      expect.stringContaining('[token-usage-gc] scan failed'),
      expect.objectContaining({ retentionDays: TOKEN_USAGE_RETENTION_DAYS }),
      expect.any(Error),
    );
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
