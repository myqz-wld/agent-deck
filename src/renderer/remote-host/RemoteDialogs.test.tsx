// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteHostManagerDialog } from '@renderer/components/RemoteHost/RemoteHostManagerDialog';
import { RemoteSessionCreateDialog } from '@renderer/components/RemoteHost/RemoteSessionCreateDialog';
import { HistoryPanel } from '@renderer/components/HistoryPanel';
import { SessionList } from '@renderer/components/SessionList';
import type { RemoteHostProfileDto } from '@shared/remote-host';
import type { RemoteSessionSourceView } from './source-types';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';

afterEach(cleanup);

const REMOTE_PROFILE: RemoteHostProfileDto = {
  id: 'remote-a',
  label: 'Production Core',
  topology: 'server-core',
  endpoint: {
    hostname: 'core.example.test',
    port: 22,
    username: 'agentdeck',
    expectedInstanceId: 'core-a',
    hostKeyAlias: null,
  },
  credentials: { identityFileConfigured: true, knownHostsFileConfigured: true },
};

function source(projects: RemoteSessionSourceView['projects']): RemoteSessionSourceView {
  return {
    busy: false,
    capabilities: new Set(['session-console.create']),
    error: null,
    history: null,
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreProjects: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    pendingBySession: new Map(),
    profile: REMOTE_PROFILE,
    projects,
    recoveringWorker: false,
    runtime: null,
    sessionTotal: null,
    selectedPending: null,
    selectedSession: null,
    selectedSessionId: null,
    sessions: [],
    state: null,
    usable: true,
    clearError: vi.fn(),
    createSession: vi.fn(),
    interrupt: vi.fn(),
    loadMoreHistorySessions: vi.fn(),
    loadMoreProjects: vi.fn(),
    loadMoreSessions: vi.fn(),
    refresh: vi.fn(),
    respondPending: vi.fn(),
    selectSession: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(),
    updateRuntime: vi.fn(),
  };
}

function hosts(
  selectProfile: () => Promise<void>,
  error: { code: string; message: string } | null = null,
): RemoteHostSnapshotState {
  return {
    snapshot: {
      revision: 1,
      sourceMode: 'local',
      selectedRemoteProfileId: REMOTE_PROFILE.id,
      profiles: [{
        id: 'local',
        label: 'Standalone',
        topology: 'standalone',
        endpoint: null,
        credentials: { identityFileConfigured: false, knownHostsFileConfigured: false },
      }, REMOTE_PROFILE],
      states: [{
        profileId: REMOTE_PROFILE.id,
        topology: 'server-core',
        status: 'offline',
        instanceId: null,
        authoritativeCoreId: null,
        workerGeneration: null,
        capabilities: [],
        eventRevision: 0,
        error,
      }],
    },
    dataRevisionByProfile: new Map(),
    busy: false,
    error: null,
    refresh: vi.fn(),
    addProfile: vi.fn(),
    updateProfile: vi.fn(),
    removeProfile: vi.fn(),
    selectProfile,
    setSourceMode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearError: vi.fn(),
  };
}

describe('remote source surfaces', () => {
  it('preserves an explicit project selection across project refreshes', () => {
    const initial = source([
      { projectId: 'a', projectRef: 'ref-a', alias: 'a', title: 'Project A' },
      { projectId: 'b', projectRef: 'ref-b', alias: 'b', title: 'Project B' },
    ]);
    const view = render(<RemoteSessionCreateDialog open source={initial} onClose={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: '项目' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ref-b' } });

    view.rerender(<RemoteSessionCreateDialog
      open
      source={source([
        { projectId: 'a', projectRef: 'ref-a', alias: 'a', title: 'Project A updated' },
        { projectId: 'b', projectRef: 'ref-b', alias: 'b', title: 'Project B' },
        { projectId: 'c', projectRef: 'ref-c', alias: 'c', title: 'Project C' },
      ])}
      onClose={vi.fn()}
    />);
    expect(select.value).toBe('ref-b');
  });

  it('consumes rejected profile-focus promises instead of creating an unhandled rejection', async () => {
    const selectProfile = vi.fn(() => Promise.reject(new Error('selection failed')));
    render(<RemoteHostManagerDialog open hosts={hosts(selectProfile)} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Production Core').closest('button')!);
    await waitFor(() => expect(selectProfile).toHaveBeenCalledWith('remote-a'));
    await Promise.resolve();
  });

  it('surfaces uncertain retirement as a restart-only fail-closed state', () => {
    render(<RemoteHostManagerDialog
      open
      hosts={hosts(vi.fn(), {
        code: 'transport-close-failed',
        message: '本机 SSH 退出状态不确定。',
      })}
      onClose={vi.fn()}
    />);
    expect(screen.getByText(/安全栅栏不会自动放宽/)).toBeTruthy();
    expect(screen.getByText(/重启 Agent Deck 后恢复/)).toBeTruthy();
  });

  it('presents includeArchived results as bounded summaries, not authoritative history', () => {
    const row = {
      id: 'session-a', adapterId: 'codex-cli', title: 'Summary row', status: 'closed',
      createdAt: 1, updatedAt: 2,
    };
    render(<HistoryPanel
      remoteSource={{ ...source([]), historySessions: [row] }}
      onSelect={vi.fn()}
    />);
    expect(screen.getByText('远程会话摘要')).toBeTruthy();
    expect(screen.getByText(/当前远程协议提供有界会话摘要/)).toBeTruthy();
    expect(screen.getByText('Summary row')).toBeTruthy();
  });

  it('shows only loaded count when the remote total is unavailable', () => {
    const row = {
      id: 'session-a', adapterId: 'codex-cli', title: 'Live row', status: 'active',
      createdAt: 1, updatedAt: 2,
    };
    const view = render(<SessionList
      remoteSource={{ ...source([]), error: '远程 session 不存在或已删除。', sessions: [row], sessionTotal: null }}
    />);
    expect(screen.getByText(/已载入 1/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('不存在或已删除');
    view.rerender(<SessionList
      remoteSource={{ ...source([]), sessions: [row], sessionTotal: 9 }}
    />);
    expect(screen.getByText(/1\/9/)).toBeTruthy();
  });
});
