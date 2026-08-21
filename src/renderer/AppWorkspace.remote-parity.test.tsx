// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from './remote-host/source-types';
import type { RemoteUsageSourceView } from './remote-host/use-remote-usage-source';
import type { AppView } from './components/AppHeader';
import type { RemoteHostConnectionStatus } from '@shared/remote-host';

const readiness = vi.hoisted(() => ({ history: true, issues: true, pending: true }));

vi.mock('./components/DataPanel', () => ({
  DataPanel: ({ remoteUsage }: { remoteUsage: RemoteUsageSourceView | null }) => (
    <div data-testid="data">{remoteUsage ? 'remote data' : 'local data'}</div>
  ),
}));
vi.mock('./components/HistoryPanel', () => ({
  HistoryPanel: ({
    remoteSource,
    onPresentationReadyChange,
  }: {
    remoteSource?: RemoteSessionSourceView;
    onPresentationReadyChange?: (ready: boolean) => void;
  }) => (
    <div
      ref={(node) => { if (node) onPresentationReadyChange?.(readiness.history); }}
      data-testid="history"
    >
      {remoteSource ? 'remote history' : 'local history'}
    </div>
  ),
}));
vi.mock('./components/IssuesPanel', () => ({
  IssuesPanel: ({
    onPresentationReadyChange,
  }: {
    onPresentationReadyChange?: (ready: boolean) => void;
  }) => <div
    ref={(node) => { if (node) onPresentationReadyChange?.(readiness.issues); }}
    data-testid="issues"
  >local issues</div>,
}));
vi.mock('./components/issues/RemoteIssuesPanel', () => ({
  RemoteIssuesPanel: ({
    source,
    onPresentationReadyChange,
  }: {
    source: RemoteSessionSourceView;
    onPresentationReadyChange?: (ready: boolean) => void;
  }) => (
    <div
      ref={(node) => { if (node) onPresentationReadyChange?.(readiness.issues); }}
      data-testid="issues"
    >
      {source ? 'remote issues' : 'invalid'}
    </div>
  ),
}));
vi.mock('./components/PendingTab', () => ({
  PendingTab: ({
    remoteSource,
    onPresentationReadyChange,
  }: {
    remoteSource?: RemoteSessionSourceView;
    onPresentationReadyChange?: (ready: boolean) => void;
  }) => (
    <div
      ref={(node) => { if (node) onPresentationReadyChange?.(readiness.pending); }}
      data-testid="pending"
    >
      {remoteSource ? 'remote pending' : 'local pending'}
    </div>
  ),
}));
vi.mock('./components/SessionDetail', () => ({
  SessionDetail: ({ remoteSource }: { remoteSource?: RemoteSessionSourceView }) => (
    <div data-testid="detail">{remoteSource ? 'remote detail' : 'local detail'}</div>
  ),
}));
vi.mock('./components/SessionList', () => ({
  SessionList: ({ remoteSource }: { remoteSource?: RemoteSessionSourceView }) => (
    <div data-testid="live">{remoteSource ? 'remote live' : 'local live'}</div>
  ),
}));

import { AppWorkspace } from './AppWorkspace';

afterEach(() => {
  cleanup();
  readiness.history = true;
  readiness.issues = true;
  readiness.pending = true;
  vi.useRealTimers();
});

function source(
  capabilities: string[],
  selectedSessionId: string | null = null,
  status: RemoteHostConnectionStatus = 'connected',
  usable = status === 'connected',
): RemoteSessionSourceView {
  return {
    capabilities: new Set(capabilities),
    profile: { id: 'remote-a', label: 'Remote A', scope: 'remote' },
    state: {
      profileId: 'remote-a', status, recovery: null, authoritativeCoreId: 'core-a',
      workerGeneration: 1, capabilities, eventRevision: 1, error: null,
    },
    selectedSessionId,
    selectSession: vi.fn(),
    usable,
  } as unknown as RemoteSessionSourceView;
}

const usage = {
  enabled: true,
  identity: 'remote-a:core-a:1',
} as unknown as RemoteUsageSourceView;

function workspace(
  view: AppView,
  remoteMode: boolean,
  capabilities: string[],
  selectedSessionId: string | null = null,
  status: RemoteHostConnectionStatus = 'connected',
  usable = status === 'connected',
) {
  return render(
    <AppWorkspace
      view={view}
      authority={remoteMode ? 'remote' : 'local'}
      authorityError={null}
      onAuthorityRetry={vi.fn()}
      localDetail={null}
      remoteSource={source(capabilities, selectedSessionId, status, usable)}
      remoteUsage={usage}
      onLocalClose={vi.fn()}
      onLocalHistorySelect={vi.fn()}
      onOpenLocalSession={vi.fn()}
      onViewChange={vi.fn()}
    />,
  );
}

describe('AppWorkspace Local and Remote page parity', () => {
  it.each([
    ['live', 'live', ['sessions.presentation.read']],
    ['pending', 'pending', ['pending.index.read']],
    ['history', 'history', ['sessions.presentation.read']],
  ] as const)('routes %s through the selected source without Local fallback', (
    view,
    testId,
    capabilities,
  ) => {
    workspace(view, false, []);
    expect(screen.getByTestId(testId).textContent).toBe(`local ${testId}`);
    cleanup();
    workspace(view, true, [...capabilities]);
    expect(screen.getByTestId(testId).textContent).toBe(`remote ${testId}`);
  });

  it('keeps History mounted offscreen so tab switches reuse the prefetched projection', () => {
    const current = workspace('live', false, []);
    const history = screen.getByTestId('history');
    expect(history.parentElement?.hidden).toBe(true);

    current.rerender(
      <AppWorkspace
        view="history"
        authority="local"
        authorityError={null}
        onAuthorityRetry={vi.fn()}
        localDetail={null}
        remoteSource={source([])}
        remoteUsage={usage}
        onLocalClose={vi.fn()}
        onLocalHistorySelect={vi.fn()}
        onOpenLocalSession={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('history')).toBe(history);
    expect(history.parentElement?.hidden).toBe(false);
  });

  it('retains and inerts the previous workspace until History is complete or has a fallback', () => {
    readiness.history = false;
    const current = workspace('live', false, []);
    const props = {
      authority: 'local' as const,
      authorityError: null,
      onAuthorityRetry: vi.fn(),
      localDetail: null,
      remoteSource: source([]),
      remoteUsage: usage,
      onLocalClose: vi.fn(),
      onLocalHistorySelect: vi.fn(),
      onOpenLocalSession: vi.fn(),
      onViewChange: vi.fn(),
    };

    current.rerender(<AppWorkspace {...props} view="history" />);
    expect(screen.getByTestId('live')).toBeTruthy();
    expect(screen.getByTestId('live').closest('[inert]')).toBeTruthy();
    expect(screen.getByTestId('history').parentElement?.hidden).toBe(true);

    readiness.history = true;
    current.rerender(<AppWorkspace {...props} view="history" />);
    expect(screen.queryByTestId('live')).toBeNull();
    expect(screen.getByTestId('history').parentElement?.hidden).toBe(false);
  });

  it('keeps Issues mounted offscreen so tab switches reuse the prefetched projection', () => {
    const current = workspace('live', false, []);
    const issues = screen.getByTestId('issues');
    expect(issues.parentElement?.hidden).toBe(true);

    current.rerender(
      <AppWorkspace
        view="issues"
        authority="local"
        authorityError={null}
        onAuthorityRetry={vi.fn()}
        localDetail={null}
        remoteSource={source([])}
        remoteUsage={usage}
        onLocalClose={vi.fn()}
        onLocalHistorySelect={vi.fn()}
        onOpenLocalSession={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('issues')).toBe(issues);
    expect(issues.parentElement?.hidden).toBe(false);
  });

  it('routes Remote session detail through the Remote source', () => {
    workspace('live', true, ['sessions.presentation.read'], 'remote-session');
    expect(screen.getByTestId('detail').textContent).toBe('remote detail');
  });

  it('retains the Remote list for 149 ms before a slow detail fallback', async () => {
    vi.useFakeTimers();
    const currentSource = source(['sessions.presentation.read']);
    const props = {
      authority: 'remote' as const,
      authorityError: null,
      onAuthorityRetry: vi.fn(),
      localDetail: null,
      remoteUsage: usage,
      onLocalClose: vi.fn(),
      onLocalHistorySelect: vi.fn(),
      onOpenLocalSession: vi.fn(),
      onViewChange: vi.fn(),
    };
    const view = render(<AppWorkspace {...props} view="live" remoteSource={currentSource} />);
    const pendingSource = source(
      ['sessions.presentation.read'],
      'remote-session',
    );
    pendingSource.selectedSession = null;
    view.rerender(<AppWorkspace {...props} view="live" remoteSource={pendingSource} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByTestId('live')).toBeTruthy();
    expect(screen.getByTestId('live').closest('[inert]')).toBeTruthy();
    expect(screen.queryByTestId('detail')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByTestId('detail')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByTestId('detail')).toBeTruthy();
    expect(screen.queryByTestId('live')).toBeNull();
  });

  it('renders the same DataPanel component without mixing Local usage', () => {
    workspace('data', false, []);
    expect(screen.getByTestId('data').textContent).toBe('local data');
    cleanup();
    workspace('data', true, ['usage']);
    expect(screen.getByTestId('data').textContent).toBe('remote data');
  });

  it('uses the Remote issues implementation only when the Core advertises issues', () => {
    workspace('issues', false, []);
    expect(screen.getByTestId('issues').textContent).toBe('local issues');
    cleanup();
    workspace('issues', true, ['issues']);
    expect(screen.getByTestId('issues').textContent).toBe('remote issues');
  });

  it.each([
    ['live', 'sessions.presentation.read', 'reconnecting', true],
    ['pending', 'pending.index.read', 'offline', false],
    ['history', 'sessions.presentation.read', 'incompatible', false],
    ['issues', 'issues', 'offline', false],
    ['data', 'usage', 'incompatible', false],
  ] as const)('does not mount %s while the Remote source is %s', (
    view,
    capability,
    status,
    usable,
  ) => {
    const capabilities = [capability];
    workspace(view, true, capabilities, null, status, usable);
    expect(screen.queryByTestId(view)).toBeNull();
    expect(screen.getByTestId('remote-page-unavailable')).toBeTruthy();
    expect(screen.getByTestId('remote-page-unavailable')).toBeTruthy();
  });

  it('does not mount a selected Remote detail while its connection is reconnecting', () => {
    workspace(
      'live',
      true,
      ['sessions.presentation.read'],
      'remote-session',
      'reconnecting',
      true,
    );
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.getByTestId('remote-page-unavailable')).toBeTruthy();
  });

  it('mounts neither Local nor Remote business UI before source authority is known', () => {
    const onAuthorityRetry = vi.fn();
    render(
      <AppWorkspace
        view="live"
        authority="unknown"
        authorityError="snapshot unavailable"
        onAuthorityRetry={onAuthorityRetry}
        localDetail={null}
        remoteSource={source([])}
        remoteUsage={usage}
        onLocalClose={vi.fn()}
        onLocalHistorySelect={vi.fn()}
        onOpenLocalSession={vi.fn()}
        onViewChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('live')).toBeNull();
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.getByText('无法确认数据源')).toBeTruthy();
    expect(screen.getByText('数据来源读取失败，请稍后重试。')).toBeTruthy();
    screen.getByRole('button', { name: '重新读取数据源' }).click();
    expect(onAuthorityRetry).toHaveBeenCalledOnce();
  });
});
