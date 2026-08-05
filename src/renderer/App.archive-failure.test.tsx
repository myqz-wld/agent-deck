// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CallerArchiveFailedEvent } from '@shared/types';

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
    archiveSession: vi.fn(),
  };
});

vi.mock('./stores/session-store', () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
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
vi.mock('./components/TeamHub', () => ({ TeamHub: () => <div>teams</div> }));
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
  mocks.archiveSession.mockReset().mockResolvedValue(undefined);
  const off = vi.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => ({ alwaysOnTop: true, windowTransparent: true })),
      setAlwaysOnTop: vi.fn(async () => undefined),
      takePendingSessionFocus: vi.fn(async () => null),
      onPinToggled: vi.fn(() => off),
      onTransparentToggled: vi.fn(() => off),
      onCompactToggled: vi.fn(() => off),
      onSessionFocusRequest: vi.fn(() => off),
      onSessionRenamed: vi.fn(() => off),
      onCallerArchiveFailed: vi.fn((listener: (payload: CallerArchiveFailedEvent) => void) => {
        mocks.archiveListener = listener;
        return off;
      }),
      getRemoteHostSnapshot: vi.fn(async () => ({
        revision: 1,
        sourceMode: 'local',
        selectedRemoteProfileId: null,
        profiles: [],
        states: [],
      })),
      onRemoteHostChanged: vi.fn(() => off),
      archiveSession: mocks.archiveSession,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('App caller archive failure banner', () => {
  it('shows a bounded detailed row-missing reason without a retry action and can dismiss it', () => {
    render(<App />);
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
