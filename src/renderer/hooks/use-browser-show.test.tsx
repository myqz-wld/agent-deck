// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserShowRequest, BrowserStateSource } from '@shared/browser-view';
import { useBrowserShowRequest } from './use-browser-show';

const source = { kind: 'local' as const, sessionId: 'owner-a' };
const request: BrowserShowRequest = { requestId: 'show-1', source, tabId: 1 };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let pending: BrowserShowRequest | null;
let listener: (value: BrowserShowRequest | null) => void;
const off = vi.fn();
const getPending = vi.fn();

beforeEach(() => {
  pending = null;
  listener = () => {};
  vi.clearAllMocks();
  getPending.mockImplementation(async () => pending);
  window.api = {
    getPendingBrowserShow: getPending,
    onBrowserShowRequested: (callback) => { listener = callback; return off; },
  } as unknown as typeof window.api;
});
afterEach(cleanup);

it('refreshes the presented tab and retains its placement after completion', async () => {
  const hook = renderHook(() => useBrowserShowRequest(source, 1));
  await act(flush);
  act(() => { pending = request; listener(request); });
  await act(flush);
  expect(hook.result.current).toBe('show-1');
  act(() => { pending = null; listener(null); });
  expect(hook.result.current).toBe('show-1');
  act(() => { pending = { ...request, requestId: 'show-2' }; listener(pending); });
  await act(flush);
  expect(hook.result.current).toBe('show-2');
  hook.unmount();
  expect(off).toHaveBeenCalledOnce();
});

it('ignores requests for another owner or tab and never handles a Remote panel', async () => {
  const hook = renderHook(({ activeSource, tabId }) => useBrowserShowRequest(activeSource, tabId), {
    initialProps: { activeSource: source as BrowserStateSource, tabId: 2 },
  });
  await act(flush);
  act(() => { pending = request; listener(request); });
  await act(flush);
  expect(hook.result.current).toBeNull();
  hook.rerender({ activeSource: { kind: 'local', sessionId: 'owner-b' }, tabId: 1 });
  await act(flush);
  expect(hook.result.current).toBeNull();
  getPending.mockClear();
  hook.rerender({ activeSource: {
    kind: 'remote', sessionId: source.sessionId, profileId: 'profile', coreId: 'core', generation: 1,
  }, tabId: 1 });
  await act(flush);
  expect(hook.result.current).toBeNull();
  expect(getPending).not.toHaveBeenCalled();
});

it('rejects an expired request and fences an older startup read', async () => {
  let resolveInitial!: (value: BrowserShowRequest | null) => void;
  getPending.mockImplementationOnce(() => new Promise((done) => { resolveInitial = done; }));
  const hook = renderHook(() => useBrowserShowRequest(source, 1));
  act(() => listener(request));
  await act(flush);
  expect(hook.result.current).toBeNull();
  act(() => { pending = { ...request, requestId: 'new' }; listener(pending); });
  await act(flush);
  await act(async () => { resolveInitial(request); await flush(); });
  expect(hook.result.current).toBe('new');
});
