// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from './remote-host/source-types';
import type { RemoteUsageSourceView } from './remote-host/use-remote-usage-source';

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
vi.mock('./components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('./components/IssuesPanel', () => ({ IssuesPanel: () => null }));
vi.mock('./components/issues/RemoteIssuesPanel', () => ({ RemoteIssuesPanel: () => null }));
vi.mock('./components/PendingTab', () => ({ PendingTab: () => null }));
vi.mock('./components/SessionDetail', () => ({ SessionDetail: () => null }));
vi.mock('./components/SessionList', () => ({ SessionList: () => null }));

import { AppWorkspace } from './AppWorkspace';

afterEach(cleanup);

function source(capabilities: string[]): RemoteSessionSourceView {
  return {
    capabilities: new Set(capabilities),
    selectedSessionId: null,
    selectSession: vi.fn(),
  } as unknown as RemoteSessionSourceView;
}

const usage = {
  enabled: true,
  identity: 'remote-a:core-a:1',
} as unknown as RemoteUsageSourceView;

function workspace(view: 'teams' | 'data', remoteMode: boolean, capabilities: string[]) {
  return render(
    <AppWorkspace
      view={view}
      remoteMode={remoteMode}
      localDetail={null}
      remoteSource={source(capabilities)}
      remoteUsage={usage}
      onLocalClose={vi.fn()}
      onLocalHistorySelect={vi.fn()}
      onOpenLocalSession={vi.fn()}
      onViewChange={vi.fn()}
    />,
  );
}

describe('AppWorkspace Local and Remote page parity', () => {
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

  it('fails closed when the Remote Core omits the page capability', () => {
    workspace('teams', true, []);
    expect(screen.queryByTestId('teams')).toBeNull();
    expect(screen.getByText(/远程协议当前未提供对应能力/)).toBeTruthy();
  });
});
