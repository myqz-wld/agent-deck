// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CallerArchiveFailedEvent } from '@shared/types';
import type { RemoteHostDataChangedDto, RemoteHostSnapshotDto } from '@shared/remote-host';

const mocks = vi.hoisted(() => {
  const state = {
    sessions: new Map(),
    selectedSessionId: null,
    selectSession: vi.fn(),
    setPendingRequestsAll: vi.fn(),
    pendingRevisionsBySession: new Map(),
    pendingPermissionsBySession: new Map(),
    pendingAskQuestionsBySession: new Map(),
    pendingExitPlanModesBySession: new Map(),
    pendingDiffReviewsBySession: new Map(),
  };
  return {
    state,
    archiveListener: null as ((payload: CallerArchiveFailedEvent) => void) | null,
    remoteChangedListener: null as ((payload: RemoteHostDataChangedDto) => void) | null,
    archiveSession: vi.fn(),
    getRemoteHostSnapshot: vi.fn(),
    onSessionFocusRequest: vi.fn(),
    takePendingSessionFocus: vi.fn(),
  };
});

vi.mock('./stores/session-store', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state, subscribe: vi.fn(() => vi.fn()) },
  ),
}));
vi.mock('./hooks/use-event-bridge', () => ({ useEventBridge: vi.fn() }));
vi.mock('./hooks/use-issues-bridge', () => ({ useIssuesBridge: vi.fn() }));
vi.mock('./hooks/use-startup-data-preload', () => ({ useStartupDataPreload: vi.fn() }));
vi.mock('./components/diff/install', () => ({ registerBuiltinDiffRenderers: vi.fn() }));
vi.mock('./lib/load-stable-snapshot', () => ({ loadStableSnapshot: vi.fn(async () => 'applied') }));
vi.mock('./lib/session-selectors', () => ({
  selectLiveSessions: () => [],
  selectPendingBuckets: () => ({}),
  sumPendingBuckets: () => 0,
}));
vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('./components/FloatingFrame', () => ({
  FloatingFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('./components/AppHeader', () => ({ AppHeader: () => <div>header</div> }));
vi.mock('./components/SessionList', () => ({ SessionList: () => <div>sessions</div> }));
vi.mock('./components/SessionDetail', () => ({ SessionDetail: () => <div>detail</div> }));
vi.mock('./components/HistoryPanel', () => ({ HistoryPanel: () => <div>history</div> }));
vi.mock('./components/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('./components/NewSessionDialog', () => ({ NewSessionDialog: () => null }));
vi.mock('./components/AssetsLibraryDialog', () => ({ AssetsLibraryDialog: () => null }));
vi.mock('./components/PendingTab', () => ({ PendingTab: () => <div>pending</div> }));
vi.mock('./components/IssuesPanel', () => ({ IssuesPanel: () => <div>issues</div> }));
vi.mock('./components/DataPanel', () => ({ DataPanel: () => <div>data</div> }));

import { App } from './App';

function emitArchiveFailure(payload: CallerArchiveFailedEvent): void {
  act(() => mocks.archiveListener?.(payload));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.archiveListener = null;
  mocks.remoteChangedListener = null;
  mocks.archiveSession.mockReset().mockResolvedValue(undefined);
  mocks.state.selectSession.mockReset();
  mocks.getRemoteHostSnapshot.mockReset().mockResolvedValue({
    revision: 1,
    sourceMode: 'local',
    selectedRemoteProfileId: null,
    profiles: [],
    states: [],
  });
  mocks.takePendingSessionFocus.mockReset().mockResolvedValue(null);
  const off = vi.fn();
  mocks.onSessionFocusRequest.mockReset().mockImplementation(() => off);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => ({ alwaysOnTop: true, windowTransparent: true })),
      setAlwaysOnTop: vi.fn(async () => undefined),
      takePendingSessionFocus: mocks.takePendingSessionFocus,
      onPinToggled: vi.fn(() => off),
      onTransparentToggled: vi.fn(() => off),
      onCompactToggled: vi.fn(() => off),
      onSessionFocusRequest: mocks.onSessionFocusRequest,
      onSessionRenamed: vi.fn(() => off),
      onCallerArchiveFailed: vi.fn((listener: (payload: CallerArchiveFailedEvent) => void) => {
        mocks.archiveListener = listener;
        return off;
      }),
      getRemoteHostSnapshot: mocks.getRemoteHostSnapshot,
      onRemoteHostChanged: vi.fn((listener: (event: RemoteHostDataChangedDto) => void) => {
        mocks.remoteChangedListener = listener;
        return off;
      }),
      archiveSession: mocks.archiveSession,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('App caller archive failure banner', () => {
  it('shows a bounded detailed row-missing reason without a retry action and can dismiss it', async () => {
    render(<App />);
    await waitFor(() => expect(mocks.archiveListener).not.toBeNull());
    emitArchiveFailure({
      sessionId: 'missing-source',
      toolName: 'SessionHandOffCommit',
      reason: `missing:${'x'.repeat(2_100)}`,
      reasonKind: 'row-missing',
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('原会话归档失败');
    expect(alert.textContent?.length).toBeLessThan(2_100);
    expect(alert.textContent).toContain('…');
    expect(screen.queryByRole('button', { name: '重试归档' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '关闭归档失败提示' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['probe-throw', 'archive-throw'] as const)(
    'keeps a %s retry failure visible and calls the existing archive API',
    async (reasonKind) => {
      mocks.archiveSession.mockRejectedValueOnce(new Error('database still locked'));
      render(<App />);
      await waitFor(() => expect(mocks.archiveListener).not.toBeNull());
      emitArchiveFailure({
        sessionId: 'retry-source',
        toolName: 'hand_off_session',
        reason: 'initial archive failure',
        reasonKind,
      });

      fireEvent.click(screen.getByRole('button', { name: '重试归档' }));
      expect(await screen.findByText('重试归档失败：database still locked')).toBeTruthy();
      expect(mocks.archiveSession).toHaveBeenCalledWith('retry-source');
      expect(screen.getByRole('alert').textContent).toContain('initial archive failure');
      expect(screen.getByRole('button', { name: '重试归档' })).toBeTruthy();
    },
  );

  it('does not let an older retry completion dismiss a newer failure event', async () => {
    const oldRetry = deferred();
    mocks.archiveSession.mockReturnValueOnce(oldRetry.promise);
    render(<App />);
    await waitFor(() => expect(mocks.archiveListener).not.toBeNull());
    emitArchiveFailure({
      sessionId: 'old-source',
      toolName: 'hand_off_session',
      reason: 'old failure',
      reasonKind: 'archive-throw',
    });
    fireEvent.click(screen.getByRole('button', { name: '重试归档' }));

    emitArchiveFailure({
      sessionId: 'new-source',
      toolName: 'SessionHandOffCommit',
      reason: 'new failure',
      reasonKind: 'row-missing',
    });
    await act(async () => oldRetry.resolve());

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('new failure'));
    expect(screen.queryByText(/重试归档失败/)).toBeNull();
  });
});

describe('App source authority', () => {
  const remoteSnapshot: RemoteHostSnapshotDto = {
    revision: 1,
    sourceMode: 'remote',
    selectedRemoteProfileId: 'remote-a',
    profiles: [{
      id: 'remote-a', label: 'Remote A', scope: 'remote', endpoint: null,
    }],
    states: [{
      profileId: 'remote-a', status: 'connected', recovery: null,
      authoritativeCoreId: 'core-a', workerGeneration: 1,
      capabilities: [], eventRevision: 0, error: null,
    }],
  };

  it('makes no Local focus call or store write while authority is unknown', async () => {
    mocks.getRemoteHostSnapshot.mockReset().mockReturnValue(new Promise(() => undefined));
    render(<App />);
    await act(async () => { await Promise.resolve(); });

    expect(mocks.takePendingSessionFocus).not.toHaveBeenCalled();
    expect(mocks.onSessionFocusRequest).not.toHaveBeenCalled();
    expect(mocks.state.selectSession).not.toHaveBeenCalled();
    expect(screen.getByText('正在确认数据源')).toBeTruthy();
  });

  it('does not consume a retained Local focus request while Remote is authoritative', async () => {
    mocks.getRemoteHostSnapshot.mockReset().mockResolvedValue(remoteSnapshot);
    mocks.takePendingSessionFocus.mockResolvedValue('retained-local-session');
    render(<App />);
    await waitFor(() => expect(mocks.getRemoteHostSnapshot).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    expect(mocks.takePendingSessionFocus).not.toHaveBeenCalled();
    expect(mocks.onSessionFocusRequest).not.toHaveBeenCalled();
    expect(mocks.state.selectSession).not.toHaveBeenCalled();
  });

  it('consumes the retained focus request only after Local becomes authoritative', async () => {
    const localSnapshot: RemoteHostSnapshotDto = {
      ...remoteSnapshot, revision: 2, sourceMode: 'local',
    };
    mocks.getRemoteHostSnapshot.mockReset()
      .mockResolvedValueOnce(remoteSnapshot)
      .mockResolvedValue(localSnapshot);
    mocks.takePendingSessionFocus.mockResolvedValue('retained-local-session');
    render(<App />);
    await waitFor(() => expect(mocks.remoteChangedListener).not.toBeNull());
    expect(mocks.takePendingSessionFocus).not.toHaveBeenCalled();

    act(() => mocks.remoteChangedListener?.({
      revision: 2, profileId: 'remote-a', reason: 'selection', resources: [],
    }));
    await waitFor(() => expect(mocks.takePendingSessionFocus).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.state.selectSession)
      .toHaveBeenCalledWith('retained-local-session'));
    expect(mocks.onSessionFocusRequest).toHaveBeenCalledOnce();
  });
});
