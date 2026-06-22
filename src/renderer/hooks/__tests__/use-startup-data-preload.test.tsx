// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ProviderUsageSnapshot, TokenDailyRow } from '@shared/types';
import { PROVIDER_USAGE_REFETCH_MS, useStartupDataPreload } from '../use-startup-data-preload';
import { useTokenUsageStore } from '../../stores/token-usage-store';

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
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
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

beforeEach(() => {
  resetTokenUsageStore();
  tokenUsageDaily = vi.fn().mockResolvedValue([dailyRow()]);
  providerUsageSnapshot = vi.fn().mockResolvedValue({ snapshots: [claudeSnapshot()] });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      tokenUsageDaily,
      providerUsageSnapshot,
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('useStartupDataPreload', () => {
  it('keeps provider quota background refresh at ten minutes', () => {
    expect(PROVIDER_USAGE_REFETCH_MS).toBe(10 * 60_000);
  });

  it('preloads provider usage into the renderer store before DataPanel mounts', async () => {
    renderHook(() => useStartupDataPreload());

    await waitFor(() => expect(tokenUsageDaily).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(providerUsageSnapshot).toHaveBeenCalledTimes(1));

    const state = useTokenUsageStore.getState();
    expect(state.daily).toEqual([dailyRow()]);
    expect(state.providerUsageSnapshots).toEqual([expect.objectContaining({ provider: 'claude-code' })]);
    expect(state.providerUsageFetchedAt).toEqual(expect.any(Number));
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
});
