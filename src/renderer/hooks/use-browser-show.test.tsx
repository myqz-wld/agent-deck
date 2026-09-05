// @vitest-environment happy-dom
import { useCallback, useState } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserShowRequest, BrowserStateSnapshot } from '@shared/browser-view';
import type { RemoteHostSourceMode } from '@shared/remote-host';
import { IabPanel } from '@renderer/components/SessionDetail/IabPanel';
import { useBrowserShowFocus, useBrowserShowRequest, useBrowserShowTab } from './use-browser-show';

const source = { kind: 'local' as const, sessionId: 'owner-a' };
const request: BrowserShowRequest = { requestId: 'show-1', source, tabId: 1 };
const snapshot: BrowserStateSnapshot = {
  protocolVersion: 1, source, revision: 1,
  tabs: [{ id: 1, active: true, title: 'Browser test', url: 'about:blank', viewportRevision: 1 }],
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let pending: BrowserShowRequest | null;
let listener: (value: BrowserShowRequest | null) => void;
const off = vi.fn();
const getPending = vi.fn();
const begin = vi.fn();
const update = vi.fn();
const park = vi.fn();

beforeEach(() => {
  pending = null;
  listener = () => {};
  vi.clearAllMocks();
  useBrowserShowRequest.setState({ request: null });
  getPending.mockImplementation(async () => pending);
  begin.mockImplementation(async () => ({ leaseId: 'lease', source, snapshot }));
  update.mockImplementation(async () => {
    pending = null;
    listener(null);
    return { snapshot, appliedBounds: { x: 10, y: 100, width: 420, height: 480 } };
  });
  park.mockResolvedValue(true);
  window.api = {
    getPendingBrowserShow: getPending,
    onBrowserShowRequested: (callback) => { listener = callback; return off; },
    beginBrowserPresentation: begin,
    updateBrowserPresentation: update,
    parkBrowserPresentation: park,
  } as unknown as typeof window.api;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10, y: 100, width: 420, height: 480,
  } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Detail() {
  const [tab, setTab] = useState('activity');
  const key = useBrowserShowTab(source.sessionId, snapshot, () => setTab('browser'));
  return tab === 'browser' ? <IabPanel key={key} source={source} snapshot={snapshot} /> : <p>Activity</p>;
}
function AppHarness({ initialMode = 'remote' }: { initialMode?: RemoteHostSourceMode }) {
  const [mode, setMode] = useState(initialMode);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const selectMode = useCallback(async (mode: RemoteHostSourceMode) => { setMode(mode); }, []);
  useBrowserShowFocus(mode === 'local', selectMode, setSessionId);
  return <><p>{mode}:{sessionId ?? 'none'}</p>{mode === 'local' && sessionId === source.sessionId && <Detail />}</>;
}

it('focuses the owning Local session, presents IAB, and keeps the placement mounted after completion', async () => {
  const view = render(<AppHarness />);
  await act(flush);
  expect(begin).not.toHaveBeenCalled();
  act(() => { pending = request; listener(request); });
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(screen.getByText('local:owner-a')).toBeTruthy();
  expect(view.container.querySelector('[data-iab-panel]')).not.toBeNull();
  expect(park).not.toHaveBeenCalled();
  // Same owner/tab with unchanged metadata still triggers a fresh presentation for explicit show.
  act(() => { pending = { ...request, requestId: 'show-2' }; listener(pending); });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(park).toHaveBeenCalledOnce();
  expect(view.container.querySelector('[data-iab-panel]')).not.toBeNull();
});

it('recovers a pending show when the renderer starts after the event', async () => {
  pending = request;
  render(<AppHarness initialMode="local" />);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(screen.getByText('local:owner-a')).toBeTruthy();
});

it('does not navigate until Local is authoritative or after an expired request', async () => {
  const focus = vi.fn();
  let finishSelection!: () => void;
  const select = vi.fn(() => new Promise<void>((done) => { finishSelection = done; }));
  const hook = renderHook(({ local }) => useBrowserShowFocus(local, select, focus), {
    initialProps: { local: false },
  });
  await act(flush);
  act(() => { pending = request; listener(request); });
  await act(flush);
  expect(select).toHaveBeenCalledWith('local');
  expect(focus).not.toHaveBeenCalled();
  act(() => { pending = null; listener(null); finishSelection(); });
  hook.rerender({ local: true });
  await act(flush);
  expect(focus).not.toHaveBeenCalled();
});

it('fences late startup reads and unmounts, and rejects another session snapshot', async () => {
  let resolveInitial!: (value: BrowserShowRequest | null) => void;
  getPending.mockImplementationOnce(() => new Promise((done) => { resolveInitial = done; }));
  const focus = vi.fn();
  const hook = renderHook(() => useBrowserShowFocus(true, vi.fn(), focus));
  act(() => { pending = { ...request, requestId: 'new' }; listener(pending); });
  await act(flush);
  expect(focus).toHaveBeenCalledOnce();
  await act(async () => { resolveInitial(request); await flush(); });
  expect(useBrowserShowRequest.getState().request?.requestId).toBe('new');
  const showTab = vi.fn();
  renderHook(() => useBrowserShowTab('other', snapshot, showTab));
  expect(showTab).not.toHaveBeenCalled();
  hook.unmount();
  expect(off).toHaveBeenCalledOnce();
  expect(useBrowserShowRequest.getState().request).toBeNull();
});
