// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DataPanel } from '../DataPanel';
import { useTokenUsageStore } from '../../stores/token-usage-store';
import type { ProviderUsageSnapshot } from '@shared/types';

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
  });
}

function claudeSnapshot(): ProviderUsageSnapshot {
  return {
    provider: 'claude-code',
    label: 'Claude',
    status: 'ok',
    windows: [
      {
        id: 'current',
        label: '当前窗口',
        usedPercent: 0.4,
        resetsAt: null,
      },
    ],
    updatedAt: Date.now(),
  };
}

let providerUsageSnapshot: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTokenUsageStore();
  providerUsageSnapshot = vi.fn().mockResolvedValue({ snapshots: [claudeSnapshot()] });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      tokenUsageDaily: vi.fn().mockResolvedValue([]),
      tokenUsageRates: vi.fn().mockResolvedValue([]),
      tokenUsageTopToday: vi.fn().mockResolvedValue([]),
      onTokenUsageChanged: vi.fn(() => vi.fn()),
      onTokenRateTick: vi.fn(() => vi.fn()),
      providerUsageSnapshot,
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('DataPanel quota usage', () => {
  it('reads quota information on mount without adding an extra action button', async () => {
    render(<DataPanel />);

    await waitFor(() => expect(window.api.tokenUsageDaily).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(providerUsageSnapshot).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Claude')).toBeTruthy();
    expect(await screen.findByText('0%')).toBeTruthy();
    expect(screen.queryByText('0.4%')).toBeNull();
    expect(screen.queryByRole('button', { name: '读取' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
  });
});
