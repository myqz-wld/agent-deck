// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FAST_ASYNC_FALLBACK_GRACE_MS,
  useDeferredPendingIdentity,
  useInitialAsyncPresentation,
} from '../useDelayedAsyncFallback';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useInitialAsyncPresentation', () => {
  it('reveals a fast result directly and keeps later revalidation mounted', async () => {
    vi.useFakeTimers();
    const hook = renderHook(
      ({ identity, pending }) => useInitialAsyncPresentation(pending, identity),
      { initialProps: { identity: 'scope-a', pending: true } },
    );

    expect(hook.result.current).toBe('deferred');
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(hook.result.current).toBe('deferred');

    hook.rerender({ identity: 'scope-a', pending: false });
    expect(hook.result.current).toBe('ready');
    hook.rerender({ identity: 'scope-a', pending: true });
    expect(hook.result.current).toBe('ready');
  });

  it('resets synchronously for a new identity and shows fallback only after 150 ms', async () => {
    vi.useFakeTimers();
    const hook = renderHook(
      ({ identity, pending }) => useInitialAsyncPresentation(pending, identity),
      { initialProps: { identity: 'scope-a', pending: false } },
    );

    expect(hook.result.current).toBe('ready');
    hook.rerender({ identity: 'scope-b', pending: true });
    expect(hook.result.current).toBe('deferred');

    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS));
    expect(hook.result.current).toBe('fallback');
  });
});

describe('useDeferredPendingIdentity', () => {
  it('keeps the prior identity until a fast replacement settles', () => {
    const hook = renderHook(
      ({ identity, pending }) => useDeferredPendingIdentity(pending, identity),
      { initialProps: { identity: 'adapter-a', pending: false } },
    );

    hook.rerender({ identity: 'adapter-b', pending: true });
    expect(hook.result.current).toBe('adapter-a');

    hook.rerender({ identity: 'adapter-b', pending: false });
    expect(hook.result.current).toBe('adapter-b');
  });

  it('releases a still-pending replacement at the grace boundary', async () => {
    vi.useFakeTimers();
    const hook = renderHook(
      ({ identity, pending }) => useDeferredPendingIdentity(pending, identity),
      { initialProps: { identity: 'adapter-a', pending: false } },
    );

    hook.rerender({ identity: 'adapter-b', pending: true });
    await act(() => vi.advanceTimersByTimeAsync(FAST_ASYNC_FALLBACK_GRACE_MS - 1));
    expect(hook.result.current).toBe('adapter-a');

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(hook.result.current).toBe('adapter-b');
  });
});
