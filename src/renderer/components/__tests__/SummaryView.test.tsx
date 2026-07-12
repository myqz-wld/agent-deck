// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRecord, SummaryRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { SessionCard } from '../SessionCard';
import { SummaryView } from '../SummaryView';

vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));

const llmSummary: SummaryRecord = {
  id: 2,
  sessionId: 'summary-session',
  content: '优化周期总结\n进展：已接入 revision 游标\n下一步：补齐回归测试',
  trigger: 'event-count',
  ts: 200,
  sourceEventRevision: 12,
  sourceRebuildAfterRevision: 0,
  generationSource: 'llm',
};

const fallbackSummary: SummaryRecord = {
  id: 1,
  sessionId: 'summary-session',
  content: '最近助手消息',
  trigger: 'time',
  ts: 100,
  sourceEventRevision: 10,
  sourceRebuildAfterRevision: 0,
  generationSource: 'assistant-fallback',
};

const session = {
  id: 'summary-session',
  agentId: 'claude-code',
  cwd: '/repo',
  title: 'Summary Session',
  source: 'sdk',
  lifecycle: 'active',
  activity: 'idle',
  startedAt: 0,
  lastEventAt: 0,
  endedAt: null,
  archivedAt: null,
  pinnedAt: null,
} as SessionRecord;

beforeEach(() => {
  useSessionStore.setState({
    summariesBySession: new Map(),
    latestSummaryBySession: new Map(),
    summaryRevisionsBySession: new Map(),
    recentEventsBySession: new Map(),
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listSummaries: vi.fn().mockResolvedValue([llmSummary, fallbackSummary]),
      setSessionPinned: vi.fn().mockResolvedValue(session),
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('SummaryView rich periodic summaries', () => {
  it('preserves multiline content and labels normal versus degraded generations', async () => {
    render(<SummaryView sessionId="summary-session" />);
    const content = await screen.findByText(
      (_text, element) => element?.textContent === llmSummary.content,
    );
    expect(content.className).toContain('whitespace-pre-line');
    expect(screen.getByText(/AI 总结/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '展开 1 条历史' }));
    expect(screen.getByText(/降级总结/)).toBeTruthy();
    expect(screen.getByText('最近助手消息').className).toContain('whitespace-pre-line');
  });

  it('keeps the card headline compact while exposing the complete summary in its tooltip', () => {
    useSessionStore.setState({
      latestSummaryBySession: new Map([
        ['summary-session', { ...llmSummary, generationSource: 'stats-fallback' }],
      ]),
    });
    render(
      <SessionCard
        session={session}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    const headline = screen.getByText('降级 · 优化周期总结');
    expect(headline.getAttribute('title')).toBe(llmSummary.content);
  });

  it('shows a local error instead of leaking a rejected snapshot to the global fatal handler', async () => {
    window.api.listSummaries = vi.fn().mockRejectedValue(new Error('database busy'));
    render(<SummaryView sessionId="summary-session" />);
    expect(await screen.findByText('总结读取失败：database busy')).toBeTruthy();
  });

  it('retries a stale snapshot instead of overwriting a newly pushed summary', async () => {
    let resolveFirst!: (rows: SummaryRecord[]) => void;
    const fresh = { ...llmSummary, id: 3, ts: 300, content: '刚生成的总结' };
    window.api.listSummaries = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<SummaryRecord[]>((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValueOnce([fresh, llmSummary, fallbackSummary]);

    render(<SummaryView sessionId="summary-session" />);
    act(() => useSessionStore.getState().pushSummary(fresh));
    await act(async () => resolveFirst([llmSummary, fallbackSummary]));

    expect(await screen.findByText('刚生成的总结')).toBeTruthy();
    expect(window.api.listSummaries).toHaveBeenCalledTimes(2);
  });
});
