// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUsageProviderResult } from '@contracts/usage';
import type { ProviderUsageSnapshot, TokenDailyRow } from '@shared/types';
import { DataPanelView } from './DataPanelView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function view(snapshot: ProviderUsageSnapshot) {
  const daily: TokenDailyRow = {
    day: '2026-09-04', bucketKey: 'gpt-6-astra',
    providerTotalTokens: 300, providerTotalApplicable: true,
    inputTotalTokens: 100, inputTotalApplicable: true,
    outputTokens: 200, outputApplicable: true,
    reasoningTokens: 50, reasoningApplicable: true,
    cacheReadTokens: 20, cacheReadApplicable: true,
    cacheCreationTokens: 0, cacheCreationApplicable: true,
  };
  // The Remote transport uses the same strict DTO before reaching the shared presentation.
  const snapshots = parseUsageProviderResult({ snapshots: [snapshot], revision: 1 }).snapshots;
  return <DataPanelView
    rates={[{ bucketKey: 'gpt-6-astra', outputTokens: 600 }]}
    ratesLoading={false} ratesError={null} liveBySession={{}} rateDescription="最近 60 秒"
    daily={[daily]} today="2026-09-04" dailyLoading={false} dailyError={null} dailyTruncated={false}
    usageSnapshots={snapshots} usageFetchedAt={1} usageLoading={false} usageError={null}
    onRefreshProviders={async () => undefined}
  />;
}

function snapshot(astraPercent: number): ProviderUsageSnapshot {
  return {
    provider: 'codex-cli', label: 'Codex CLI', status: 'ok', updatedAt: 1,
    windows: [
      { id: 'current', label: '当前窗口', usedPercent: 12, resetsAt: null },
      { id: 'weekly', label: '周用量', usedPercent: 24, resetsAt: null },
      { id: 'current', quotaId: 'gpt-6-astra', label: 'GPT-6 Astra · 当前窗口', usedPercent: astraPercent, resetsAt: null },
      { id: 'weekly', quotaId: 'gpt-6-astra', label: 'GPT-6 Astra · 周用量', usedPercent: 40, resetsAt: null },
    ],
  };
}

describe('Data panel Astra quota and token presentation', () => {
  it('renders default and Astra quotas alongside Astra token totals and live rates', () => {
    render(view(snapshot(75)));
    expect(screen.getByText('当前窗口')).toBeTruthy();
    expect(screen.getByText('GPT-6 Astra · 当前窗口')).toBeTruthy();
    expect(screen.getByText('GPT-6 Astra · 周用量')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getAllByText('gpt-6-astra')).toHaveLength(2);
    expect(screen.getByText('合计 10 token/s')).toBeTruthy();
    expect(screen.getAllByText('输入总量')).toHaveLength(2);
    expect(screen.getAllByText('输出总量')).toHaveLength(2);
    expect(screen.getByRole('cell', { name: '100' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '200' })).toBeTruthy();
  });

  it('keeps quota rows distinct when values refresh or a model-specific quota disappears', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = render(view(snapshot(75)));
    mounted.rerender(view(snapshot(82)));
    expect(screen.queryByText('75%')).toBeNull();
    expect(screen.getByText('82%')).toBeTruthy();
    mounted.rerender(view({ ...snapshot(82), windows: snapshot(82).windows.slice(0, 2) }));
    expect(screen.queryByText('GPT-6 Astra · 当前窗口')).toBeNull();
    expect(screen.getByText('当前窗口')).toBeTruthy();
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key|unique.*key/i);
  });
});
