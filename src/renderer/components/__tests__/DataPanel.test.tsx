// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DataPanel } from '../DataPanel';
import { useTokenUsageStore } from '../../stores/token-usage-store';
import type { ProviderUsageSnapshot, TokenDailyRow } from '@shared/types';
import type { RemoteUsageSourceView } from '../../remote-host/use-remote-usage-source';
import { resetTokenDailyRefreshForTests } from '../../lib/token-daily-refresh';

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
    inputTotalTokens: 10,
    outputTokens: 30,
    reasoningTokens: 12,
    cacheReadTokens: 5,
    cacheCreationTokens: 0,
    providerTotalApplicable: true,
    inputTotalApplicable: true,
    outputApplicable: true,
    reasoningApplicable: true,
    cacheReadApplicable: true,
    cacheCreationApplicable: true,
    ...over,
    providerTotalTokens: over.providerTotalTokens ?? null,
  };
}

let providerUsageSnapshot: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTokenDailyRefreshForTests();
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
  resetTokenDailyRefreshForTests();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

describe('DataPanel quota usage', () => {
  it('uses the shared presentation with Remote data and never falls back to Local IPC', async () => {
    const loadDaily = vi.fn(async () => undefined);
    const loadProviders = vi.fn(async () => undefined);
    const remoteUsage: RemoteUsageSourceView = {
      enabled: true,
      identity: 'remote-a:core-a:1',
      rates: [{ bucketKey: 'gpt-5.6-sol', outputTokens: 60 }],
      topToday: [{ bucketKey: 'gpt-5.6-sol', outputTokens: 600 }],
      ratesLoading: false,
      ratesError: null,
      today: tokenDailyRow().day,
      daily: [tokenDailyRow({ bucketKey: 'gpt-5.6-sol' })],
      dailyLoading: false,
      dailyError: null,
      dailyTruncated: false,
      providerSnapshots: [claudeSnapshot()],
      providerFetchedAt: Date.now(),
      providerLoading: false,
      providerError: null,
      loadDaily,
      loadProviders,
    };

    render(<DataPanel remoteUsage={remoteUsage} />);

    await waitFor(() => expect(loadDaily).toHaveBeenCalledOnce());
    expect(loadProviders).toHaveBeenCalledWith(false);
    expect(window.api.tokenUsageDaily).not.toHaveBeenCalled();
    expect(window.api.tokenUsageRates).not.toHaveBeenCalled();
    expect(window.api.tokenUsageTopToday).not.toHaveBeenCalled();
    expect(providerUsageSnapshot).not.toHaveBeenCalled();
    expect(screen.getAllByText('gpt-5.6-sol')).toHaveLength(2);
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('does not start Remote reads when the supplied usage source is disabled', async () => {
    const loadDaily = vi.fn(async () => undefined);
    const loadProviders = vi.fn(async () => undefined);
    const remoteUsage = {
      enabled: false,
      identity: 'remote-a:core-a:1',
      rates: [], topToday: [], ratesLoading: false, ratesError: null,
      today: null, daily: [], dailyLoading: false,
      dailyError: null, dailyTruncated: false, providerSnapshots: [],
      providerFetchedAt: null, providerLoading: false, providerError: null,
      loadDaily, loadProviders,
    } satisfies RemoteUsageSourceView;

    render(<DataPanel remoteUsage={remoteUsage} />);
    await Promise.resolve();

    expect(loadDaily).not.toHaveBeenCalled();
    expect(loadProviders).not.toHaveBeenCalled();
    expect(window.api.tokenUsageDaily).not.toHaveBeenCalled();
    expect(providerUsageSnapshot).not.toHaveBeenCalled();
  });

  it('does not duplicate initial Remote reads on an equivalent source rerender', async () => {
    const loadDaily = vi.fn(async () => undefined);
    const loadProviders = vi.fn(async () => undefined);
    const remoteUsage = {
      enabled: true,
      identity: 'remote-a:core-a:1',
      rates: [], topToday: [], ratesLoading: false, ratesError: null,
      today: null, daily: [], dailyLoading: false,
      dailyError: null, dailyTruncated: false, providerSnapshots: [],
      providerFetchedAt: null, providerLoading: false, providerError: null,
      loadDaily, loadProviders,
    } satisfies RemoteUsageSourceView;
    const view = render(<DataPanel remoteUsage={remoteUsage} />);
    await waitFor(() => expect(loadDaily).toHaveBeenCalledOnce());
    expect(loadProviders).toHaveBeenCalledOnce();

    view.rerender(<DataPanel remoteUsage={{ ...remoteUsage }} />);
    await act(async () => { await Promise.resolve(); });
    expect(loadDaily).toHaveBeenCalledOnce();
    expect(loadProviders).toHaveBeenCalledOnce();
  });

  it('shows unified token totals and marks cache/reasoning as included breakdowns', async () => {
    (window.api.tokenUsageDaily as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      tokenDailyRow(),
    ]);

    render(<DataPanel />);

    expect(screen.getByText('今日 Token')).toBeTruthy();
    expect(screen.getByText('输入总量')).toBeTruthy();
    expect(screen.getByText('输出总量')).toBeTruthy();
    expect(screen.getByText(/统计规则：/)).toBeTruthy();
    expect(screen.getByText(/输入总量已包含缓存读\/写/)).toBeTruthy();
    expect(screen.getByText(/“其中”已计入左侧总量/)).toBeTruthy();
    const todaySummary = screen.getByText('今日 Token');
    const accounting = screen.getByText(/统计规则：/);
    const dailyDetails = screen.getByText('每模型每天明细');
    const todaySection = todaySummary.closest('section');
    expect(todaySection?.classList.contains('rounded')).toBe(false);
    expect(todaySection?.classList.contains('border')).toBe(false);
    expect(todaySummary.parentElement?.classList.contains('mb-1')).toBe(true);
    expect(
      todaySummary.compareDocumentPosition(accounting) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      accounting.compareDocumentPosition(dailyDetails) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(await screen.findByText('2026-06-19')).toBeTruthy();
    expect(screen.queryByText('Provider 总计')).toBeNull();
    expect(screen.getByText('推理')).toBeTruthy();
    expect(screen.getByText('其中推理')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    const outputLabel = screen
      .getAllByText('输出总量')
      .find((element) => element.tagName === 'SPAN');
    const outputValue = outputLabel?.parentElement?.querySelector('.text-sm');
    expect(outputValue?.classList.contains('text-status-working')).toBe(false);
    const detailRow = screen.getByText('2026-06-19').closest('tr');
    const detailOutput = detailRow?.querySelectorAll('td').item(5);
    expect(detailOutput?.classList.contains('text-status-working')).toBe(false);
  });

  it('ignores out-of-scope multi-model rows without treating unknown values as zero', async () => {
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    (window.api.tokenUsageDaily as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      tokenDailyRow({
        day: today,
        bucketKey: 'opus-4.8',
        inputTotalTokens: 25,
        outputTokens: 8,
        reasoningTokens: null,
        reasoningApplicable: false,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
      }),
      tokenDailyRow({
        day: today,
        bucketKey: 'claude-unattributed-reasoning',
        providerTotalTokens: null,
        providerTotalApplicable: false,
        inputTotalTokens: null,
        inputTotalApplicable: false,
        outputTokens: null,
        outputApplicable: false,
        reasoningTokens: 7,
        reasoningApplicable: true,
        cacheReadTokens: null,
        cacheReadApplicable: false,
        cacheCreationTokens: null,
        cacheCreationApplicable: false,
      }),
    ]);

    render(<DataPanel />);

    await screen.findByText('claude-unattributed-reasoning');
    const outputLabel = screen
      .getAllByText('输出总量')
      .find((element) => element.tagName === 'SPAN');
    const outputCard = outputLabel?.parentElement?.parentElement;
    expect(outputCard?.textContent).toContain('8');
    expect(outputCard?.textContent).toContain('推理 7');
    const inputLabel = screen
      .getAllByText('输入总量')
      .find((element) => element.tagName === 'SPAN');
    const inputCard = inputLabel?.parentElement?.parentElement;
    expect(inputCard?.textContent).toContain('25');
  });

  it('shows unavailable when every row is out of scope instead of fabricating zero', async () => {
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    (window.api.tokenUsageDaily as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      tokenDailyRow({
        day: today,
        bucketKey: 'claude-unattributed-reasoning',
        providerTotalTokens: null,
        providerTotalApplicable: false,
        inputTotalTokens: null,
        inputTotalApplicable: false,
        outputTokens: null,
        outputApplicable: false,
        reasoningTokens: 7,
        reasoningApplicable: true,
        cacheReadTokens: null,
        cacheReadApplicable: false,
        cacheCreationTokens: null,
        cacheCreationApplicable: false,
      }),
    ]);

    render(<DataPanel />);

    await screen.findByText('claude-unattributed-reasoning');
    const outputLabel = screen
      .getAllByText('输出总量')
      .find((element) => element.tagName === 'SPAN');
    const outputCard = outputLabel?.parentElement?.parentElement;
    expect(outputCard?.textContent).toContain('—');
    expect(outputCard?.textContent).toContain('推理 7');
    expect(outputCard?.textContent).not.toContain('输出总量0');
  });

  it('uses startup-preloaded quota snapshots without a first-open provider read', async () => {
    useTokenUsageStore.setState({
      providerUsageSnapshots: [claudeSnapshot()],
      providerUsageFetchedAt: Date.now(),
    });

    render(<DataPanel />);

    await waitFor(() => expect(window.api.tokenUsageDaily).toHaveBeenCalledTimes(1));
    expect(window.api.tokenUsageDaily).toHaveBeenCalledWith({ includeGrokHistory: true });
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
    expect(window.api.onTokenUsageChanged).toHaveBeenCalledTimes(1);
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

  it('prefers a fresh Grok live token rate over the persisted 60-second window', () => {
    useTokenUsageStore.setState({
      rates: [{ bucketKey: 'grok-4.5', outputTokens: 60 }],
      liveBySession: {
        'grok-session': { bucketKey: 'grok-4.5', tps: 42.5, updatedAt: Date.now() },
      },
    });

    render(<DataPanel />);

    expect(screen.getByText('43')).toBeTruthy();
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
