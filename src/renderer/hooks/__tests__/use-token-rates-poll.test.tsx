// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_SHUTDOWN_ERROR_MESSAGE,
} from '@shared/shutdown';
import type { TokenRateRow, TokenUsageChangedEvent } from '@shared/types';
import { useTokenUsageStore } from '../../stores/token-usage-store';
import { useTokenRatesPoll } from '../use-token-rates-poll';

const rateRows: TokenRateRow[] = [{ bucketKey: 'rate', outputTokens: 10 }];
const topRows: TokenRateRow[] = [{ bucketKey: 'today', outputTokens: 20 }];

let emitUsageChanged: ((event: TokenUsageChangedEvent) => void) | null;
let tokenUsageRates: ReturnType<typeof vi.fn>;
let tokenUsageTopToday: ReturnType<typeof vi.fn>;
let offTick: ReturnType<typeof vi.fn>;
let offUsage: ReturnType<typeof vi.fn>;

function resetStore(): void {
  useTokenUsageStore.setState({
    rates: [],
    topToday: [],
    daily: [],
    liveBySession: {},
    providerUsageSnapshots: [],
    providerUsageFetchedAt: null,
    providerUsageLoading: false,
    providerUsageError: null,
    providerUsageRequestId: 0,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function rendererShutdownError(channel: string): Error {
  return new Error(
    `Error invoking remote method '${channel}': ` +
      `AppShutdownError: ${APP_SHUTDOWN_ERROR_MESSAGE}`,
  );
}

async function flushTimers(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  emitUsageChanged = null;
  tokenUsageRates = vi.fn().mockResolvedValue(rateRows);
  tokenUsageTopToday = vi.fn().mockResolvedValue(topRows);
  offTick = vi.fn();
  offUsage = vi.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      tokenUsageRates,
      tokenUsageTopToday,
      onTokenRateTick: vi.fn(() => offTick),
      onTokenUsageChanged: vi.fn((callback) => {
        emitUsageChanged = callback;
        return offUsage;
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.useRealTimers();
});

describe('useTokenRatesPoll', () => {
  it('polls immediately, on the interval, and after the bounded usage-change debounce', async () => {
    renderHook(() => useTokenRatesPoll(1_000));
    await flushTimers();
    expect(tokenUsageRates).toHaveBeenCalledTimes(1);
    expect(tokenUsageTopToday).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(tokenUsageRates).toHaveBeenCalledTimes(2);

    act(() => {
      emitUsageChanged?.({ sessionId: 's1', ts: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(tokenUsageRates).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(tokenUsageRates).toHaveBeenCalledTimes(3);
    expect(useTokenUsageStore.getState().rates).toEqual(rateRows);
    expect(useTokenUsageStore.getState().topToday).toEqual(topRows);
  });

  it('stops future interval and debounce polls on the exact shutdown rejection', async () => {
    const pendingTop = deferred<TokenRateRow[]>();
    tokenUsageRates.mockRejectedValue(
      rendererShutdownError('token-usage-rates'),
    );
    tokenUsageTopToday.mockReturnValue(pendingTop.promise);

    renderHook(() => useTokenRatesPoll(1_000));
    await flushTimers();
    expect(tokenUsageRates).toHaveBeenCalledOnce();

    act(() => {
      emitUsageChanged?.({ sessionId: 's1', ts: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(tokenUsageRates).toHaveBeenCalledOnce();
    expect(tokenUsageTopToday).toHaveBeenCalledOnce();
    expect(useTokenUsageStore.getState().rates).toEqual([]);
    expect(useTokenUsageStore.getState().topToday).toEqual([]);
  });

  it('catches transient failures without misclassifying them as shutdown or stopping retries', async () => {
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    tokenUsageRates.mockRejectedValueOnce(
      new Error(`temporary rates failure mentions ${APP_SHUTDOWN_ERROR_MESSAGE} only`),
    );
    tokenUsageTopToday.mockRejectedValueOnce(new Error('temporary top failure'));

    renderHook(() => useTokenRatesPoll(1_000));
    await flushTimers();
    expect(unhandled).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(tokenUsageRates).toHaveBeenCalledTimes(2);
    expect(tokenUsageTopToday).toHaveBeenCalledTimes(2);
    expect(useTokenUsageStore.getState().rates).toEqual(rateRows);
    window.removeEventListener('unhandledrejection', unhandled);
  });

  it('absorbs in-flight rejection after unmount and performs no later store update', async () => {
    const rates = deferred<TokenRateRow[]>();
    const top = deferred<TokenRateRow[]>();
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    tokenUsageRates.mockReturnValueOnce(rates.promise);
    tokenUsageTopToday.mockReturnValueOnce(top.promise);

    const { unmount } = renderHook(() => useTokenRatesPoll(1_000));
    unmount();
    rates.reject(new Error('late rates failure'));
    top.reject(new Error('late top failure'));
    await flushTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(unhandled).not.toHaveBeenCalled();
    expect(tokenUsageRates).toHaveBeenCalledOnce();
    expect(useTokenUsageStore.getState().rates).toEqual([]);
    expect(offTick).toHaveBeenCalledOnce();
    expect(offUsage).toHaveBeenCalledOnce();
    window.removeEventListener('unhandledrejection', unhandled);
  });
});
