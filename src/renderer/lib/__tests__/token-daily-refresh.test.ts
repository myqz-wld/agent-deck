// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenDailyRow } from '@shared/types';

const loggerSpies = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => loggerSpies },
}));

import {
  createTokenDailyRefreshCoordinator,
  requestTokenDailyRefresh,
  resetTokenDailyRefreshForTests,
} from '../token-daily-refresh';

function row(bucketKey: string): TokenDailyRow {
  return {
    bucketKey,
    day: '2026-06-01',
    providerTotalTokens: null,
    providerTotalApplicable: false,
    inputTotalTokens: 1,
    inputTotalApplicable: true,
    outputTokens: 1,
    outputApplicable: true,
    reasoningTokens: null,
    reasoningApplicable: false,
    cacheReadTokens: null,
    cacheReadApplicable: false,
    cacheCreationTokens: null,
    cacheCreationApplicable: false,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  resetTokenDailyRefreshForTests();
  Reflect.deleteProperty(window, 'api');
  loggerSpies.warn.mockReset();
  vi.useRealTimers();
});

describe('token daily refresh coordinator', () => {
  it('queues strong behind weak and fences the stale weak completion', async () => {
    const weak = deferred<TokenDailyRow[]>();
    const strong = deferred<TokenDailyRow[]>();
    const read = vi.fn()
      .mockReturnValueOnce(weak.promise)
      .mockReturnValueOnce(strong.promise);
    const apply = vi.fn();
    const coordinator = createTokenDailyRefreshCoordinator({ read, apply });

    coordinator.request(false);
    coordinator.request(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenNthCalledWith(1);

    weak.resolve([row('weak')]);
    await flush();
    expect(apply).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(2, { includeGrokHistory: true });

    strong.resolve([row('strong')]);
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith([row('strong')]);
  });

  it('lets a strong in-flight request satisfy overlapping weak demand', async () => {
    const pending = deferred<TokenDailyRow[]>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const apply = vi.fn();
    const coordinator = createTokenDailyRefreshCoordinator({ read, apply });

    coordinator.request(true);
    coordinator.request(false);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve([row('strong')]);
    await flush();
    expect(apply).toHaveBeenCalledWith([row('strong')]);
  });

  it('coalesces event bursts during flight into one strongest follow-up', async () => {
    const first = deferred<TokenDailyRow[]>();
    const followUp = deferred<TokenDailyRow[]>();
    const read = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(followUp.promise);
    const apply = vi.fn();
    const coordinator = createTokenDailyRefreshCoordinator({ read, apply });

    coordinator.request(true);
    coordinator.invalidate();
    coordinator.invalidate();
    coordinator.invalidate();
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve([row('stale')]);
    await flush();
    expect(apply).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith({ includeGrokHistory: true });

    followUp.resolve([row('fresh')]);
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([row('fresh')]);
  });

  it('continues a queued refresh after failure without overwriting store data', async () => {
    const first = deferred<TokenDailyRow[]>();
    const followUp = deferred<TokenDailyRow[]>();
    const read = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(followUp.promise);
    const apply = vi.fn();
    const warn = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const coordinator = createTokenDailyRefreshCoordinator({ read, apply, warn });

    coordinator.request(false);
    coordinator.invalidate();
    first.reject(new Error('read failed'));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith();
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();

    followUp.resolve([row('recovered')]);
    await flush();
    expect(apply).toHaveBeenCalledWith([row('recovered')]);
  });

  it('uses a fixed production diagnostic without forwarding failure details', async () => {
    const sensitiveFailure = new Error(
      'secret-token at /Users/private/file via https://internal.invalid',
    );
    const tokenUsageDaily = vi.fn().mockRejectedValue(sensitiveFailure);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { tokenUsageDaily },
    });

    requestTokenDailyRefresh();
    await flush();

    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'Daily usage refresh failed',
    );
    const logged = JSON.stringify(loggerSpies.warn.mock.calls);
    expect(logged).not.toContain(sensitiveFailure.message);
    expect(logged).not.toContain('/Users/private/file');
    expect(logged).not.toContain('https://internal.invalid');
    expect(logged).not.toContain('secret-token');
  });

  it('debounces idle invalidations and stops subscription/lifecycle writes', async () => {
    vi.useFakeTimers();
    const pending = deferred<TokenDailyRow[]>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const apply = vi.fn();
    let listener: (() => void) | undefined;
    const off = vi.fn();
    const subscribe = vi.fn((next: () => void) => {
      listener = next;
      return off;
    });
    const coordinator = createTokenDailyRefreshCoordinator({
      read,
      apply,
      subscribe,
      debounceMs: 500,
    });

    const stop = coordinator.start();
    expect(read).toHaveBeenCalledTimes(1);
    listener?.();
    listener?.();
    stop();
    expect(off).toHaveBeenCalledTimes(1);
    pending.resolve([row('late')]);
    await vi.runAllTimersAsync();
    await flush();
    expect(apply).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('consumes a pending idle debounce when an explicit strong request runs first', async () => {
    vi.useFakeTimers();
    const pending = deferred<TokenDailyRow[]>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const apply = vi.fn();
    const coordinator = createTokenDailyRefreshCoordinator({
      read,
      apply,
      debounceMs: 500,
    });

    coordinator.setStrongDemand(true);
    coordinator.invalidate();
    coordinator.request(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ includeGrokHistory: true });

    pending.resolve([row('strong')]);
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([row('strong')]);

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('uses and releases strong demand for idle event refreshes', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue([row('fresh')]);
    const coordinator = createTokenDailyRefreshCoordinator({
      read,
      apply: vi.fn(),
      debounceMs: 500,
    });

    coordinator.setStrongDemand(true);
    coordinator.invalidate();
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenLastCalledWith({ includeGrokHistory: true });
    await flush();

    coordinator.setStrongDemand(false);
    coordinator.invalidate();
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenLastCalledWith();
  });
});
