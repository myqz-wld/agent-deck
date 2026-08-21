// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';

import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { ActivityRecordsView } from '../activity-feed/records-view';
import { SummaryRecordsView } from '../SummaryView';
import { SessionMessagesView } from './MessagesPanel';
import { TaskRecordsView } from './TasksPanel';

function Panels({ loaded }: { loaded: boolean }): JSX.Element {
  return (
    <>
      <ActivityRecordsView
        events={[]}
        loaded={loaded}
        loadError={null}
        sessionId="session-a"
        agentId="codex-cli"
        isSdk
      />
      <TaskRecordsView
        tasks={[]}
        loaded={loaded}
        error={null}
        presentationIdentity="session-a"
      />
      <SummaryRecordsView
        summaries={[]}
        loaded={loaded}
        loadError={null}
        presentationIdentity="session-a"
      />
      <SessionMessagesView
        sessionId="session-a"
        messages={[]}
        loaded={loaded}
        error={null}
      />
    </>
  );
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Session detail async panel readiness', () => {
  it('suppresses all fast-path loaders until 150 ms and then reveals stable fallbacks', async () => {
    const view = render(<Panels loaded={false} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByText('加载中…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('加载中…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getAllByText('加载中…')).toHaveLength(4);

    view.rerender(<Panels loaded />);
    expect(screen.queryByText('加载中…')).toBeNull();
    expect(screen.getByText('无活动记录')).toBeTruthy();
    expect(screen.getByText('本会话暂无任务')).toBeTruthy();
    expect(screen.getByText(/暂无总结/u)).toBeTruthy();
    expect(screen.getByText('本会话暂无跨会话消息')).toBeTruthy();
  });
});
