// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import type { ProviderUsageSnapshot, TokenDailyRow } from '@shared/types';
import { PROVIDER_USAGE_REFETCH_MS, useStartupDataPreload } from '../use-startup-data-preload';
import { useTokenUsageStore } from '../../stores/token-usage-store';
import { resetTokenDailyRefreshForTests } from '../../lib/token-daily-refresh';
import { DataPanel } from '../../components/DataPanel';

function resetTokenUsageStore(): void {
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

function dailyRow(): TokenDailyRow {
  return {
    day: '2026-06-19',
    bucketKey: 'opus-4.8',
    providerTotalTokens: null,
    inputTokens: 10,
    inputTotalTokens: 80,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
    providerTotalApplicable: true,
    inputApplicable: true,
    inputTotalApplicable: true,
    outputApplicable: true,
    reasoningApplicable: true,
    cacheReadApplicable: true,
    cacheCreationApplicable: true,
  };
}

function claudeSnapshot(): ProviderUsageSnapshot {
  return {
    provider: 'claude-code',
    label: 'Claude',
    status: 'ok',
    windows: [],
    updatedAt: Date.now(),
  };
}

let tokenUsageDaily: ReturnType<typeof vi.fn>;
let providerUsageSnapshot: ReturnType<typeof vi.fn>;
let onTokenUsageChanged: ReturnType<typeof vi.fn>;
let offTokenUsageChanged: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTokenDailyRefreshForTests();
  resetTokenUsageStore();
  tokenUsageDaily = vi.fn().mockResolvedValue([dailyRow()]);
  providerUsageSnapshot = vi.fn().mockResolvedValue({ snapshots: [claudeSnapshot()] });
  offTokenUsageChanged = vi.fn();
  onTokenUsageChanged = vi.fn(() => offTokenUsageChanged);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      tokenUsageDaily,
      providerUsageSnapshot,
      onTokenUsageChanged,
      tokenUsageRates: vi.fn().mockResolvedValue([]),
      tokenUsageTopToday: vi.fn().mockResolvedValue([]),
      onTokenRateTick: vi.fn(() => vi.fn()),
    },
  });
});

afterEach(() => {
  cleanup();
  resetTokenDailyRefreshForTests();
  Reflect.deleteProperty(window, 'api');
});

describe('useStartupDataPreload', () => {
  it('keeps provider quota background refresh at ten minutes', () => {
    expect(PROVIDER_USAGE_REFETCH_MS).toBe(10 * 60_000);
  });

  it('preloads provider usage into the renderer store before DataPanel mounts', async () => {
    const { unmount } = renderHook(() => useStartupDataPreload());

    await waitFor(() => expect(tokenUsageDaily).toHaveBeenCalledTimes(1));
    expect(tokenUsageDaily).toHaveBeenCalledWith();
    expect(onTokenUsageChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(providerUsageSnapshot).toHaveBeenCalledTimes(1));

    const state = useTokenUsageStore.getState();
    expect(state.daily).toEqual([dailyRow()]);
    expect(state.providerUsageSnapshots).toEqual([expect.objectContaining({ provider: 'claude-code' })]);
    expect(state.providerUsageFetchedAt).toEqual(expect.any(Number));
    unmount();
    expect(offTokenUsageChanged).toHaveBeenCalledTimes(1);
  });

  it('refreshes provider usage in the background while DataPanel is unmounted', async () => {
    vi.useFakeTimers();
    renderHook(() => useStartupDataPreload());

    await vi.advanceTimersByTimeAsync(0);
    expect(providerUsageSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_REFETCH_MS);
    expect(providerUsageSnapshot).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('serializes startup weak + DataPanel strong reads without stale store writes', async () => {
    let resolveWeak!: (rows: TokenDailyRow[]) => void;
    tokenUsageDaily
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveWeak = resolve;
      }))
      .mockResolvedValueOnce([dailyRow()]);

    renderHook(() => useStartupDataPreload());
    render(<DataPanel />);
    await waitFor(() => expect(tokenUsageDaily).toHaveBeenCalledTimes(1));
    expect(tokenUsageDaily).toHaveBeenNthCalledWith(1);

    await act(async () => {
      resolveWeak([{ ...dailyRow(), bucketKey: 'stale-weak' }]);
    });
    await waitFor(() => expect(tokenUsageDaily).toHaveBeenCalledTimes(2));
    expect(tokenUsageDaily).toHaveBeenNthCalledWith(
      2,
      { includeGrokHistory: true },
    );
    await waitFor(() => {
      expect(useTokenUsageStore.getState().daily).toEqual([dailyRow()]);
    });
  });
});
