// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DataPanel } from '../DataPanel';
import { useTokenUsageStore } from '../../stores/token-usage-store';
import type { ProviderUsageSnapshot, TokenDailyRow } from '@shared/types';

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

function claudeSnapshot(usedPercent = 0.4, updatedAt = Date.now()): ProviderUsageSnapshot {
  return {
    provider: 'claude-code',
    label: 'Claude',
    status: 'ok',
    windows: [
      {
        id: 'current',
        label: '当前窗口',
        usedPercent,
        resetsAt: null,
      },
    ],
    updatedAt,
  };
}

function grokSnapshot(): ProviderUsageSnapshot {
  return {
    provider: 'grok-build',
    label: 'Grok',
    status: 'ok',
    windows: [
      {
        id: 'weekly',
        label: '周用量',
        usedPercent: null,
        resetsAt: '2026-07-29T00:00:00.000Z',
      },
    ],
    updatedAt: Date.now(),
  };
}

function tokenDailyRow(over: Partial<TokenDailyRow> = {}): TokenDailyRow {
  return {
    day: '2026-06-19',
    bucketKey: 'gpt-5.5',
    inputTokens: 10,
    outputTokens: 30,
    reasoningTokens: 12,
    cacheReadTokens: 5,
    cacheCreationTokens: 0,
    ...over,
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
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

describe('DataPanel quota usage', () => {
  it('explains token accounting and renders the reasoning token column', async () => {
    (window.api.tokenUsageDaily as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      tokenDailyRow(),
    ]);

    render(<DataPanel />);

    expect(screen.getByText('Token 口径')).toBeTruthy();
    expect(screen.getByText(/Claude Code：/)).toBeTruthy();
    expect(screen.getByText(/Codex：/)).toBeTruthy();
    expect(screen.getByText(/这些列有的互相包含/)).toBeTruthy();
    expect(screen.getByText(/总输入 = 输入 \+ 缓存读 \+ 缓存写/)).toBeTruthy();
    expect(screen.getByText(/如果有推理值，它已经包含在输出里/)).toBeTruthy();
    expect(screen.getByText(/输入已经包含缓存读/)).toBeTruthy();
    expect(screen.getByText(/推理也已经包含在输出里/)).toBeTruthy();
    const todaySummary = screen.getByText(/今日汇总/);
    const accounting = screen.getByText('Token 口径');
    const dailyDetails = screen.getByText('每模型每天明细');
    expect(
      todaySummary.compareDocumentPosition(accounting) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      accounting.compareDocumentPosition(dailyDetails) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(await screen.findByText('2026-06-19')).toBeTruthy();
    expect(screen.getAllByText('推理').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('uses startup-preloaded quota snapshots without a first-open provider read', async () => {
    useTokenUsageStore.setState({
      providerUsageSnapshots: [claudeSnapshot()],
      providerUsageFetchedAt: Date.now(),
    });

    render(<DataPanel />);

    await waitFor(() => expect(window.api.tokenUsageDaily).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Claude')).toBeTruthy();
    expect(providerUsageSnapshot).not.toHaveBeenCalled();
  });

  it('does not start a DataPanel-owned automatic provider refresh timer', async () => {
    vi.useFakeTimers();
    useTokenUsageStore.setState({
      providerUsageSnapshots: [claudeSnapshot()],
      providerUsageFetchedAt: Date.now(),
    });

    render(<DataPanel />);

    expect(window.api.tokenUsageDaily).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(providerUsageSnapshot).not.toHaveBeenCalled();
  });

  it('reads quota information on mount and supports manual hard refresh', async () => {
    render(<DataPanel />);

    await waitFor(() => expect(window.api.tokenUsageDaily).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(providerUsageSnapshot).toHaveBeenCalledTimes(1));
    expect(providerUsageSnapshot.mock.calls[0]).toEqual([]);
    expect(await screen.findByText('Claude')).toBeTruthy();
    expect(await screen.findByText('0%')).toBeTruthy();
    expect(screen.queryByText('0.4%')).toBeNull();
    expect(screen.queryByRole('button', { name: '读取' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(providerUsageSnapshot).toHaveBeenCalledTimes(2));
    expect(providerUsageSnapshot).toHaveBeenLastCalledWith({ force: true });
  });

  it('renders the Grok quota card and its billing-cycle reset', async () => {
    useTokenUsageStore.setState({
      providerUsageSnapshots: [grokSnapshot()],
      providerUsageFetchedAt: Date.now(),
    });

    render(<DataPanel />);

    expect(await screen.findByText('Grok')).toBeTruthy();
    expect(screen.getByText('周用量')).toBeTruthy();
    expect(screen.getByText(/^重置 /).textContent).not.toBe('重置 未知');
  });

  it('ignores an older quota response that finishes after a newer refresh', async () => {
    let resolveInitial!: (value: { snapshots: ProviderUsageSnapshot[] }) => void;
    let resolveRefresh!: (value: { snapshots: ProviderUsageSnapshot[] }) => void;
    providerUsageSnapshot
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    useTokenUsageStore.setState({
      providerUsageSnapshots: [claudeSnapshot(5, 500)],
      providerUsageFetchedAt: null,
    });

    render(<DataPanel />);

    await waitFor(() => expect(providerUsageSnapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(providerUsageSnapshot).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveRefresh({ snapshots: [claudeSnapshot(80, 2000)] });
    });
    expect(await screen.findByText('80%')).toBeTruthy();

    await act(async () => {
      resolveInitial({ snapshots: [claudeSnapshot(10, 1000)] });
    });

    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.queryByText('10%')).toBeNull();
  });
});
