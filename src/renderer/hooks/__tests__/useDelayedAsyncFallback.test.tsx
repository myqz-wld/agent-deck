// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FAST_ASYNC_FALLBACK_GRACE_MS,
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
