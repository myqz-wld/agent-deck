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
  scope: 'remote',
  endpoint: {
    hostname: 'core.example.test',
    port: 22,
    username: 'agentdeck',
    hostKeyFingerprint: 'SHA256:test',
  },
  credentials: { connectionCredentialConfigured: true },
};

function source(): RemoteSessionSourceView {
  return {
    busy: false,
    capabilities: new Set(['session-console.create']),
    error: null,
    history: null,
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    pendingBySession: new Map(),
    profile: REMOTE_PROFILE,
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
        scope: 'local',
        endpoint: null,
        credentials: { connectionCredentialConfigured: false },
      }, REMOTE_PROFILE],
      states: [{
        profileId: REMOTE_PROFILE.id,
        status: 'offline',
        recovery: null,
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
  it('imports one server-issued credential without topology or key-file controls', async () => {
    const chooseRemoteHostConnection = vi.fn(async () => ({
      selectionId: 'connection-a',
      label: 'Issued production',
      endpoint: {
        hostname: 'issued.example.test',
        port: 22,
        username: 'agentdeck',
        hostKeyFingerprint: 'SHA256:issued',
      },
    }));
    window.api = { chooseRemoteHostConnection } as unknown as typeof window.api;
    render(<RemoteHostManagerDialog open hosts={hosts(vi.fn())} onClose={vi.fn()} />);

    expect(screen.getByText('管理连接；当前数据源仍由顶部菜单选择。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: /连接凭证/ }));
    await waitFor(() => expect(chooseRemoteHostConnection).toHaveBeenCalledOnce());
    expect(screen.getByDisplayValue('Issued production')).toBeTruthy();
    expect(screen.getByText('agentdeck@issued.example.test:22')).toBeTruthy();
    expect(screen.getByText('SHA256:issued')).toBeTruthy();
    expect(screen.queryByText(/拓扑|instanceId|known_hosts|SSH 私钥/u)).toBeNull();
  });

  it('creates from an explicit Workspace-relative working directory', async () => {
    const current = source();
    render(<RemoteSessionCreateDialog open source={current} onClose={vi.fn()} />);
    const directory = screen.getByRole('textbox', { name: '工作目录' }) as HTMLInputElement;
    expect(directory.value).toBe('.');
    fireEvent.change(directory, { target: { value: 'repo/subdir' } });
    fireEvent.change(screen.getByRole('textbox', { name: '第一条消息' }), {
      target: { value: 'Inspect the repository' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(current.createSession)
      .toHaveBeenCalledWith('claude-code', 'repo/subdir', 'Inspect the repository'));
    expect(screen.getByText(/客户端不会看到宿主机绝对路径/)).toBeTruthy();
    expect(screen.getByText(/绝对路径、`\.\.` 和越界软链接都会被拒绝/)).toBeTruthy();
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
      remoteSource={{ ...source(), historySessions: [row] }}
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
      remoteSource={{ ...source(), error: '远程 session 不存在或已删除。', sessions: [row], sessionTotal: null }}
    />);
    expect(screen.getByText(/已载入 1/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('不存在或已删除');
    view.rerender(<SessionList
      remoteSource={{ ...source(), sessions: [row], sessionTotal: 9 }}
    />);
    expect(screen.getByText(/1\/9/)).toBeTruthy();
  });
});
