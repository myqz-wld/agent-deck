// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { useSessionStore } from '@renderer/stores/session-store';
import { PendingTab } from '../PendingTab';

beforeEach(() => {
  vi.useFakeTimers();
  useSessionStore.setState({
    sessions: new Map(),
    pendingPermissionsBySession: new Map(),
    pendingAskQuestionsBySession: new Map(),
    pendingExitPlanModesBySession: new Map(),
    pendingDiffReviewsBySession: new Map(),
    pendingInitialized: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStore.setState({ pendingInitialized: true });
});

describe('PendingTab initial readiness', () => {
  it('retains the previous workspace for 149 ms, then exposes one stable fallback', async () => {
    const onPresentationReadyChange = vi.fn();
    render(<PendingTab
      onOpenSession={vi.fn()}
      onPresentationReadyChange={onPresentationReadyChange}
    />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onPresentationReadyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText('加载中…')).toBeNull();
    expect(screen.queryByText('没有待处理事项')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(screen.queryByText('加载中…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('加载中…')).toBeTruthy();
    expect(onPresentationReadyChange).toHaveBeenLastCalledWith(true);

    act(() => useSessionStore.getState().markPendingInitialized());
    expect(screen.getByText('没有待处理事项')).toBeTruthy();
  });
});
