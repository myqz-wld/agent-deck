// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FAST_ASYNC_FALLBACK_GRACE_MS } from '@renderer/hooks/useDelayedAsyncFallback';
import { useDelayedTabSelection } from '../use-delayed-tab-selection';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDelayedTabSelection', () => {
  it('commits a fast deferred tab only when its data is ready', () => {
    const hook = renderHook(
      ({ ready }) => useDelayedTabSelection({
        canDefer: true,
        deferredTab: 'permissions',
        identity: 'session-a',
        ready,
      }),
      { initialProps: { ready: false } },
    );

    act(() => hook.result.current.selectTab('permissions'));
    expect(hook.result.current.activeTab).toBe('activity');
    expect(hook.result.current.pendingTab).toBe('permissions');

    hook.rerender({ ready: true });
    expect(hook.result.current.activeTab).toBe('permissions');
    expect(hook.result.current.pendingTab).toBeNull();
  });

  it('commits the loading tab after the grace and cancels it on another selection', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useDelayedTabSelection({
      canDefer: true,
      deferredTab: 'permissions',
      identity: 'session-a',
      ready: false,
    }));

    act(() => hook.result.current.selectTab('permissions'));
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(hook.result.current.activeTab).toBe('activity');

    act(() => hook.result.current.selectTab('tasks'));
    expect(hook.result.current.activeTab).toBe('tasks');
    expect(hook.result.current.pendingTab).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(hook.result.current.activeTab).toBe('tasks');

    act(() => hook.result.current.selectTab('permissions'));
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS));
    expect(hook.result.current.activeTab).toBe('permissions');
  });

  it('does not project the prior session tab into a new identity', () => {
    const hook = renderHook(
      ({ identity }) => useDelayedTabSelection({
        canDefer: true,
        deferredTab: 'permissions',
        identity,
        ready: true,
      }),
      { initialProps: { identity: 'session-a' } },
    );

    act(() => hook.result.current.selectTab('permissions'));
    expect(hook.result.current.activeTab).toBe('permissions');
    hook.rerender({ identity: 'session-b' });
    expect(hook.result.current.activeTab).toBe('activity');
  });
});
