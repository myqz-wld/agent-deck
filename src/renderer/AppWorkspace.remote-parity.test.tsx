// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from './remote-host/source-types';
import type { RemoteUsageSourceView } from './remote-host/use-remote-usage-source';
import type { AppView } from './components/AppHeader';
import type { RemoteHostConnectionStatus } from '@shared/remote-host';

vi.mock('./components/TeamHub', () => ({
  TeamHub: ({ remoteSource }: { remoteSource: RemoteSessionSourceView | null }) => (
    <div data-testid="teams">{remoteSource ? 'remote teams' : 'local teams'}</div>
  ),
}));
vi.mock('./components/DataPanel', () => ({
  DataPanel: ({ remoteUsage }: { remoteUsage: RemoteUsageSourceView | null }) => (
    <div data-testid="data">{remoteUsage ? 'remote data' : 'local data'}</div>
  ),
}));
vi.mock('./components/HistoryPanel', () => ({
  HistoryPanel: ({ remoteSource }: { remoteSource?: RemoteSessionSourceView }) => (
    <div data-testid="history">{remoteSource ? 'remote history' : 'local history'}</div>
  ),
}));
vi.mock('./components/IssuesPanel', () => ({
  IssuesPanel: () => <div data-testid="issues">local issues</div>,
}));
vi.mock('./components/issues/RemoteIssuesPanel', () => ({
  RemoteIssuesPanel: ({ source }: { source: RemoteSessionSourceView }) => (
    <div data-testid="issues">{source ? 'remote issues' : 'invalid'}</div>
  ),
}));
vi.mock('./components/PendingTab', () => ({
  PendingTab: ({ remoteSource }: { remoteSource?: RemoteSessionSourceView }) => (
    <div data-testid="pending">{remoteSource ? 'remote pending' : 'local pending'}</div>
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

afterEach(cleanup);

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
      remoteMode={remoteMode}
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
    ['live', 'live', ['session-console.read']],
    ['pending', 'pending', ['session-console.read', 'pending.read']],
    ['history', 'history', ['session-console.read', 'sessions.history']],
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

  it('routes Remote session detail through the Remote source', () => {
    workspace('live', true, ['session-console.read'], 'remote-session');
    expect(screen.getByTestId('detail').textContent).toBe('remote detail');
  });

  it('renders the same TeamHub component against the selected data source', () => {
    workspace('teams', false, []);
    expect(screen.getByTestId('teams').textContent).toBe('local teams');
    cleanup();
    workspace('teams', true, ['teams']);
    expect(screen.getByTestId('teams').textContent).toBe('remote teams');
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

  it('fails closed when the Remote Core omits the page capability', () => {
    workspace('teams', true, []);
    expect(screen.queryByTestId('teams')).toBeNull();
    expect(screen.getByText(/当前 Remote Core 未提供团队能力/)).toBeTruthy();
  });

  it.each([
    ['live', 'session-console.read', 'reconnecting', true],
    ['pending', 'pending.read', 'offline', false],
    ['history', 'sessions.history', 'incompatible', false],
    ['teams', 'teams', 'reconnecting', true],
    ['issues', 'issues', 'offline', false],
    ['data', 'usage', 'incompatible', false],
  ] as const)('does not mount %s while the Remote source is %s', (
    view,
    capability,
    status,
    usable,
  ) => {
    const capabilities = view === 'pending'
      ? ['session-console.read', capability]
      : view === 'history'
        ? ['session-console.read', capability]
        : [capability];
    workspace(view, true, capabilities, null, status, usable);
    expect(screen.queryByTestId(view)).toBeNull();
    expect(screen.getByTestId('remote-page-unavailable')).toBeTruthy();
    expect(screen.getByText(/不会回退读取 Local 数据/u)).toBeTruthy();
  });

  it('does not mount a selected Remote detail while its connection is reconnecting', () => {
    workspace(
      'live',
      true,
      ['session-console.read'],
      'remote-session',
      'reconnecting',
      true,
    );
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.getByTestId('remote-page-unavailable')).toBeTruthy();
  });
});
