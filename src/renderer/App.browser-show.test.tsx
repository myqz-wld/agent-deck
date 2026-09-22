// @vitest-environment happy-dom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserShowRequest, BrowserStateSnapshot } from '@shared/browser-view';
import { useModalFocus } from './components/use-modal-focus';

const mocks = vi.hoisted(() => ({
  mode: 'local',
  setSourceMode: vi.fn(),
  state: {
    sessions: new Map([['viewed-session', {
      id: 'viewed-session', title: 'Viewed session', cwd: 'project', agentId: 'codex-cli',
      source: 'sdk', lifecycle: 'active', activity: 'idle', archivedAt: null,
    }]]),
    selectedSessionId: 'viewed-session',
    selectSession: vi.fn(),
    recentEventsBySession: new Map(),
  },
}));
vi.mock('./stores/session-store', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state, subscribe: () => () => {} },
  ),
}));
vi.mock('./hooks/use-local-app-bridges', () => ({ useLocalAppBridges: () => {} }));
vi.mock('./hooks/use-session-git-branches', () => ({ useSessionGitBranch: () => null }));
vi.mock('./remote-host/use-remote-host-snapshot', () => ({
  useRemoteHostSnapshot: () => ({
    snapshot: { sourceMode: mocks.mode, profiles: [], states: [], selectedRemoteProfileId: null },
    setSourceMode: mocks.setSourceMode,
  }),
}));
vi.mock('./remote-host/use-remote-session-source', () => ({
  useRemoteSessionSource: () => ({ sessions: [], capabilities: new Set(), pendingTotal: 0 }),
}));
vi.mock('./remote-host/use-remote-usage-source', () => ({ useRemoteUsageSource: () => null }));
vi.mock('./remote-host/remote-node-dialog-context', () => ({
  remoteAssetsDialogContext: () => null, remoteConfigurationDialogContext: () => null,
}));
vi.mock('./components/diff/install', () => ({ registerBuiltinDiffRenderers: () => {} }));
vi.mock('./components/AppHeader', () => ({
  AppHeader: ({ onNewSession }: { onNewSession: () => void }) =>
    <button onClick={onNewSession}>New session</button>,
}));
vi.mock('./components/FloatingFrame', () => ({
  FloatingFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./AppWorkspace', async () => {
  const { SessionDetail } = await import('./components/SessionDetail');
  return { AppWorkspace: ({ authority, localDetail }: {
    authority: string; localDetail: import('@shared/types').SessionRecord;
  }) => authority === 'local'
    ? <SessionDetail session={localDetail} onClose={() => {}} />
    : <p>Remote workspace</p> };
});
vi.mock('./components/NewSessionDialog', () => ({
  NewSessionDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    const dialogRef = useRef<HTMLDivElement>(null);
    useModalFocus({ dialogRef, open, onClose });
    return open ? <div ref={dialogRef} role="dialog" tabIndex={-1}>
      <input aria-label="Session prompt" />
      <button onClick={onClose}>Close dialog</button>
    </div> : null;
  },
}));
vi.mock('./components/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('./components/AssetsLibraryDialog', () => ({ AssetsLibraryDialog: () => null }));
vi.mock('./components/RemoteHost/RemoteHostManagerDialog', () => ({ RemoteHostManagerDialog: () => null }));
vi.mock('./components/HandOffPreviewDialog', () => ({ HandOffPreviewDialog: () => null }));
vi.mock('./components/SessionMetadataChips', () => ({ SessionMetadataChips: () => null }));
vi.mock('./components/SessionPinButton', () => ({ SessionPinButton: () => null }));
vi.mock('./components/SessionContextUsageChip', () => ({ SessionContextUsageChip: () => null }));
vi.mock('./components/activity-feed', () => ({ ActivityFeed: () => <p>Session activity</p> }));
vi.mock('./components/SessionDetail/ComposerSdk', () => ({ ComposerSdk: () => null }));
vi.mock('./components/SessionDetail/use-file-changes', () => ({ useFileChanges: () => ({ changes: [] }) }));
vi.mock('./components/SessionDetail/use-file-change-selection', () => ({ useFileChangeSelection: () => ({}) }));
vi.mock('./components/SessionDetail/use-file-change-payload', () => ({ useFileChangePayload: () => ({}) }));

import { App } from './App';

const source = { kind: 'local' as const, sessionId: 'viewed-session' };
const snapshot: BrowserStateSnapshot = {
  protocolVersion: 1, source, revision: 1,
  tabs: [{ id: 1, active: true, title: 'Example', url: 'about:blank', viewportRevision: 1 }],
};
let pending: BrowserShowRequest | null;
const listeners = new Set<(request: BrowserShowRequest | null) => void>();
const begin = vi.fn();
const update = vi.fn();
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function emit(request: BrowserShowRequest): void {
  act(() => { pending = request; for (const listener of listeners) listener(request); });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = 'local';
  listeners.clear();
  pending = { requestId: 'startup', source, tabId: 1 };
  begin.mockResolvedValue({ leaseId: 'lease', source, snapshot });
  update.mockImplementation(async () => {
    pending = null;
    for (const listener of listeners) listener(null);
    return { snapshot, appliedBounds: { x: 10, y: 100, width: 420, height: 480 } };
  });
  window.api = {
    getSettings: async () => ({ alwaysOnTop: true, windowTransparent: true }),
    setAlwaysOnTop: async () => {},
    takePendingSessionFocus: async () => null,
    onSessionFocusRequest: () => () => {},
    onPinToggled: () => () => {},
    onTransparentToggled: () => () => {},
    onCompactToggled: () => () => {},
    onSessionRenamed: () => () => {},
    onCallerArchiveFailed: () => () => {},
    getBrowserState: async () => snapshot,
    onBrowserStateChanged: () => () => {},
    getPendingBrowserShow: async () => pending,
    onBrowserShowRequested: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    beginBrowserPresentation: begin,
    updateBrowserPresentation: update,
    parkBrowserPresentation: async () => true,
  } as unknown as typeof window.api;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10, y: 100, width: 420, height: 480,
  } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['local', 'remote'])('preserves the %s source, selected session, and draft before and after closing a dialog', async (mode) => {
  mocks.mode = mode;
  render(<App />);
  await act(flush);
  expect(mocks.state.selectSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  const prompt = screen.getByRole('textbox') as HTMLInputElement;
  prompt.focus();
  fireEvent.change(prompt, { target: { value: 'A session draft' } });
  emit({ requestId: 'other-owner', source: { kind: 'local', sessionId: 'other' }, tabId: 1 });
  await act(flush);
  expect(document.activeElement).toBe(prompt);
  expect(prompt.value).toBe('A session draft');
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  await act(flush);
  expect(mocks.setSourceMode).not.toHaveBeenCalled();
  expect(mocks.state.selectSession).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  expect(screen.getByText(mode === 'local' ? 'Session activity' : 'Remote workspace')).toBeTruthy();
});

it('opens IAB only after a manual click and never reopens it after leaving', async () => {
  render(<App />);
  await act(flush);
  emit({ requestId: 'background', source, tabId: 1 });
  await act(flush);
  expect(screen.getByText('Session activity')).toBeTruthy();
  expect(begin).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'IAB' }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(document.querySelector('[data-iab-panel]')).not.toBeNull();
  emit({ requestId: 'already-open', source, tabId: 1 });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(begin).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole('button', { name: '活动' }));
  emit({ requestId: 'stay-in-background', source, tabId: 1 });
  await act(flush);
  expect(screen.getByText('Session activity')).toBeTruthy();
  expect(document.querySelector('[data-iab-panel]')).toBeNull();
  expect(begin).toHaveBeenCalledOnce();
});
