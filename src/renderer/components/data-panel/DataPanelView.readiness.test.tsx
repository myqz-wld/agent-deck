// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { DataPanelView } from './DataPanelView';

function props(): ComponentProps<typeof DataPanelView> {
  return {
    rates: [], ratesLoading: false, ratesError: null, liveBySession: {}, rateDescription: '最近 60 秒',
    daily: [], today: '2026-10-01', dailyLoading: false, dailyInitialized: true, dailyError: null, dailyTruncated: false,
    usageSnapshots: [], usageFetchedAt: null, usageLoading: false, usageError: null,
    onRefreshProviders: vi.fn().mockResolvedValue(undefined), usageSourceKey: 'remote-a',
    onConsumeReset: vi.fn().mockResolvedValue({ outcome: 'reset' }),
  };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('quota presentation readiness', () => {
  it('defers cold loading copy until 150ms and retains the explicit refresh button', () => {
    vi.useFakeTimers();
    const value = { ...props(), usageLoading: true, dailyLoading: true, ratesLoading: true, dailyInitialized: false };
    const mounted = render(<DataPanelView {...value} />);
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByText(/正在读取/)).toBeNull();
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getAllByText('正在读取额度信息')).toHaveLength(1);
    expect(screen.getByText('正在读取输出速率')).toBeTruthy();
    expect(screen.getByText('正在读取使用记录')).toBeTruthy();
    mounted.rerender(<DataPanelView {...value} usageLoading={false} dailyLoading={false} ratesLoading={false} />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(value.onRefreshProviders).toHaveBeenCalledWith(true);
  });

  it('keeps known totals and the reset control visible while refreshing', () => {
    vi.useFakeTimers();
    const value = props();
    value.daily = [{ day: '2026-10-01', bucketKey: 'test-model', providerTotalTokens: 300, providerTotalApplicable: true,
      inputTotalTokens: 100, inputTotalApplicable: true, outputTokens: 200, outputApplicable: true,
      reasoningTokens: 50, reasoningApplicable: true, cacheReadTokens: 20, cacheReadApplicable: true,
      cacheCreationTokens: 0, cacheCreationApplicable: true }];
    value.usageSnapshots = [{ provider: 'codex-cli', label: 'Codex CLI', status: 'ok', updatedAt: 1,
      windows: [{ id: 'current', label: '当前窗口', usedPercent: 12, resetsAt: null }],
      resetCredits: { accountId: 'test-account', availableCount: 2 } }];
    const mounted = render(<DataPanelView {...value} />);
    const reset = screen.getByRole('button', { name: '为 Codex CLI 使用 1 次重置' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    mounted.rerender(<DataPanelView {...value} dailyLoading usageLoading />);
    expect(screen.getAllByText('100')).toHaveLength(2);
    expect(screen.getAllByText('200')).toHaveLength(2);
    expect(screen.getByText('12%')).toBeTruthy();
    expect(screen.getByRole('button', { name: '为 Codex CLI 使用 1 次重置' })).toBe(reset);
    expect(reset.disabled).toBe(true);
    expect(screen.queryByText('刷新中')).toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getAllByText('刷新中')).toHaveLength(1);
    expect(value.onConsumeReset).not.toHaveBeenCalled();
  });
});
