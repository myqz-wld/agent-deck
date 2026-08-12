// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import { NewSessionDialog } from '@renderer/components/NewSessionDialog';
import { RemoteHostManagerDialog } from '@renderer/components/RemoteHost/RemoteHostManagerDialog';
import { HistoryPanel } from '@renderer/components/HistoryPanel';
import { SessionList } from '@renderer/components/SessionList';
import { PendingTab } from '@renderer/components/PendingTab';
import type { RemoteHostProfileDto } from '@shared/remote-host';
import type { RemoteSessionSourceView } from './source-types';
import { legacyRemoteSessionPresentation } from './session-summary-presentation';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

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
    capabilities: new Set(['session-console.create', 'session-console.read']),
    dataRevision: 0,
    resourceRevisions: {
      'session-list': 0, 'session-detail': 0, pending: 0, teams: 0,
      issues: 0, usage: 0, 'node-configuration': 0, 'node-assets': 0,
    },
    error: null,
    eventLoadError: null,
    events: null,
    historyQuery: '',
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    pendingBuckets: [],
    pendingBySession: new Map(),
    pendingLoading: false,
    pendingLoadError: null,
    pendingTotal: 0,
    pendingScanTruncated: false,
    hasMorePending: false,
    presentationCounts: null,
    profile: REMOTE_PROFILE,
    recoveringWorker: false,
    runtime: null,
    summaries: null,
    taskLoadError: null,
    tasks: null,
    sessionTotal: null,
    selectedPending: null,
    selectedSession: null,
    selectedSessionId: null,
    sessions: [],
    state: null,
    usable: true,
    clearError: vi.fn(),
    createSession: vi.fn(),
    getSessionCapabilities: vi.fn(async (request) =>
      sessionConsoleCapabilitiesFixture('codex-cli', request.workingDirectory)),
    listWorkspaceDirectories: vi.fn(async (directory) => ({
      directory,
      directories: directory === '.'
        ? [{ directory: 'repo', name: 'repo' }]
        : [],
      truncated: false,
      revision: 1,
    })),
    listFileChanges: vi.fn(),
    getFileChange: vi.fn(),
    getFileFinalDiff: vi.fn(),
    loadImageBlob: vi.fn(async () => ({ ok: false as const, reason: 'unsupported_source' as const })),
    interrupt: vi.fn(),
    previewHandOff: vi.fn(),
    commitHandOff: vi.fn(),
    loadMoreHistorySessions: vi.fn(),
    listOutgoing: vi.fn(async () => ({
      sessionId: 'session-a', adapterId: 'claude-code', messages: [], revision: 1,
    })),
    loadMorePending: vi.fn(),
    loadMoreSessions: vi.fn(),
    refresh: vi.fn(),
    respondPending: vi.fn(),
    removeOutgoing: vi.fn(async () => true),
    selectSession: vi.fn(),
    setHistoryQuery: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(),
    updateRuntime: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
    resourceRevisionsByProfile: new Map(),
    busy: false,
    error: null,
    snapshotError: null,
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
    const localListAdapters = vi.fn();
    window.api = { listAdapters: localListAdapters } as unknown as typeof window.api;
    render(<NewSessionDialog
      open
      remoteSource={current}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />);
    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalled());
    const directory = screen.getByPlaceholderText('. 或 repo/subdir') as HTMLInputElement;
    expect(directory.value).toBe('.');
    fireEvent.change(directory, { target: { value: 'repo/subdir' } });
    fireEvent.change(screen.getByRole('textbox', { name: '第一条消息' }), {
      target: { value: 'Inspect the repository' },
    });
    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: 'repo/subdir' }),
    ));
    const create = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);

    await waitFor(() => expect(current.createSession).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: 'codex-cli',
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Inspect the repository',
      workingDirectory: 'repo/subdir',
    })));
    expect(screen.getByText(/目录始终相对于 Remote Workspace/)).toBeTruthy();
    expect(screen.queryByText(/新建远程/u)).toBeNull();
    expect(localListAdapters).not.toHaveBeenCalled();
  });

  it('browses Workspace subdirectories without invoking the Local native picker', async () => {
    const current = source();
    const chooseDirectory = vi.fn();
    window.api = { chooseDirectory } as unknown as typeof window.api;
    render(<NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalled());

    const choose = screen.getByText('选择…') as HTMLButtonElement;
    await waitFor(() => expect(choose.disabled).toBe(false));
    fireEvent.click(choose);
    await waitFor(
      () => expect(current.listWorkspaceDirectories).toHaveBeenCalledWith('.'),
      { timeout: 3_000 },
    );
    expect(current.getSessionCapabilities).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Workspace')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'repo' }));
    await waitFor(
      () => expect(current.listWorkspaceDirectories).toHaveBeenCalledWith('repo'),
      { timeout: 3_000 },
    );
    expect(screen.getByText('Workspace / repo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }));

    expect((screen.getByPlaceholderText('. 或 repo/subdir') as HTMLInputElement).value)
      .toBe('repo');
    expect(screen.queryByText(/\/workspaces|\/Users|\/home/u)).toBeNull();
    expect(chooseDirectory).not.toHaveBeenCalled();
  });

  it('retires an open Workspace browser when the same Remote identity disconnects', async () => {
    const current = source();
    const pending = deferred<{
      directory: string;
      directories: { directory: string; name: string }[];
      truncated: boolean;
      revision: number;
    }>();
    vi.mocked(current.listWorkspaceDirectories).mockImplementation(() => pending.promise);
    window.api = {} as typeof window.api;
    const view = render(
      <NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('选择…'));
    await waitFor(() => expect(current.listWorkspaceDirectories).toHaveBeenCalledOnce());

    view.rerender(
      <NewSessionDialog
        open
        remoteSource={{ ...current, usable: false }}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    expect(await screen.findByText(
      '当前 Remote Worker 尚未连接，无法读取 Workspace 目录。',
    )).toBeTruthy();

    await act(async () => {
      pending.resolve({
        directory: '.',
        directories: [{ directory: 'stale-repo', name: 'stale-repo' }],
        truncated: false,
        revision: 1,
      });
      await pending.promise;
    });
    expect(screen.queryByRole('button', { name: 'stale-repo' })).toBeNull();
    expect((screen.getByRole('button', { name: '选择此目录' }) as HTMLButtonElement).disabled)
      .toBe(true);
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

  it('presents Core-owned history projections without Local fallback', () => {
    const row = {
      id: 'session-a', adapterId: 'codex-cli', title: 'Summary row', status: 'closed-finished',
      createdAt: 1, updatedAt: 2,
    };
    render(<HistoryPanel
      remoteSource={{ ...source(), historySessions: [legacyRemoteSessionPresentation(row)] }}
      onSelect={vi.fn()}
    />);
    expect(screen.getByPlaceholderText('搜索标题、工作区、事件或总结…')).toBeTruthy();
    expect(screen.getByText(/Remote Core 在完整历史索引中查询/)).toBeTruthy();
    expect(screen.getByText('Summary row')).toBeTruthy();
  });

  it('shows a partial Remote error without a source-specific load-count banner', () => {
    const row = {
      id: 'session-a', adapterId: 'codex-cli', title: 'Live row', status: 'active-idle',
      createdAt: 1, updatedAt: 2,
    };
    const view = render(<SessionList
      remoteSource={{ ...source(), error: '远程 session 不存在或已删除。', sessions: [legacyRemoteSessionPresentation(row)], sessionTotal: null }}
    />);
    expect(screen.getByText('Live row')).toBeTruthy();
    expect(screen.queryByText(/已载入/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('不存在或已删除');
    view.rerender(<SessionList
      remoteSource={{ ...source(), sessions: [legacyRemoteSessionPresentation(row)], sessionTotal: 9 }}
    />);
    expect(screen.queryByText(/1\/9/)).toBeNull();
  });

  it('does not show a false empty Pending state while the Core aggregate is loading or failed', () => {
    const pendingSource = source();
    pendingSource.capabilities = new Set(['pending.index.read', 'pending.respond']);
    const view = render(<PendingTab
      remoteSource={{ ...pendingSource, pendingLoading: true }}
      onOpenSession={vi.fn()}
    />);
    expect(screen.getByText('正在读取远程待处理事项…')).toBeTruthy();
    expect(screen.queryByText('没有待处理事项')).toBeNull();
    view.rerender(<PendingTab
      remoteSource={{
        ...pendingSource,
        pendingLoadError: '待处理索引读取失败。',
      }}
      onOpenSession={vi.fn()}
    />);
    expect(screen.getByRole('alert').textContent).toContain('待处理索引读取失败');
    expect(screen.queryByText('没有待处理事项')).toBeNull();
  });

  it('keeps an unknown Remote pending total distinct from an authoritative empty result', () => {
    const pendingSource = source();
    pendingSource.capabilities = new Set(['pending.index.read', 'pending.respond']);
    pendingSource.pendingTotal = null;
    render(<PendingTab remoteSource={pendingSource} onOpenSession={vi.fn()} />);

    expect(screen.getByText('远程待处理总数尚未确认。')).toBeTruthy();
    expect(screen.queryByText('没有待处理事项')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(pendingSource.refresh).toHaveBeenCalledOnce();
  });

  it('labels loaded Pending rows as partial while the authoritative total is unknown', () => {
    const projected = legacyRemoteSessionPresentation({
      id: 'partial-pending', adapterId: 'codex-cli', title: 'Partial pending',
      status: 'active-waiting', createdAt: 1, updatedAt: 2,
    });
    render(<PendingTab
      remoteSource={{
        ...source(),
        capabilities: new Set(['pending.index.read', 'pending.respond']),
        pendingBuckets: [{
          session: projected,
          pending: {
            requests: [{
              id: 'request-a', sessionId: projected.id, kind: 'permission', status: 'pending',
              createdAt: 2, expiresAt: null, display: {},
            }],
            revision: 4,
          },
        }],
        pendingTotal: null,
      }}
      onOpenSession={vi.fn()}
    />);

    expect(screen.getByText('总数待确认 · 已载入 1 项')).toBeTruthy();
    expect(screen.queryByText('待处理 0 项')).toBeNull();
  });

  it('renders aggregate Pending buckets independently of the loaded Live page', () => {
    const projected = legacyRemoteSessionPresentation({
      id: 'pending-after-page', adapterId: 'codex-cli', title: 'Pending after page',
      status: 'active-waiting', createdAt: 1, updatedAt: 2,
    });
    const loadMorePending = vi.fn();
    const onOpenSession = vi.fn();
    render(<PendingTab
      remoteSource={{
        ...source(),
        capabilities: new Set(['pending.index.read', 'pending.respond']),
        sessions: [],
        pendingBuckets: [{
          session: projected,
          pending: {
            requests: [{
              id: 'request-a', sessionId: projected.id, kind: 'permission', status: 'pending',
              createdAt: 2, expiresAt: null, display: {},
            }],
            revision: 4,
          },
        }],
        pendingTotal: 1,
        hasMorePending: true,
        loadMorePending,
      }}
      onOpenSession={onOpenSession}
    />);
    expect(screen.getByText('Pending after page')).toBeTruthy();
    fireEvent.click(screen.getByText('Pending after page'));
    expect(onOpenSession).toHaveBeenCalledWith(projected.id);
    fireEvent.click(screen.getByRole('button', { name: '加载更多待处理会话' }));
    expect(loadMorePending).toHaveBeenCalledOnce();
  });

  it('runs Remote permission batch actions serially through presentation-bound responses', async () => {
    const projected = legacyRemoteSessionPresentation({
      id: 'batch-session', adapterId: 'codex-cli', title: 'Batch session',
      status: 'active-waiting', createdAt: 1, updatedAt: 2,
    });
    const respondPending = vi.fn(async (
      ..._args: Parameters<RemoteSessionSourceView['respondPending']>
    ) => undefined);
    render(<PendingTab
      remoteSource={{
        ...source(),
        capabilities: new Set(['pending.index.read', 'pending.respond']),
        pendingBuckets: [{
          session: projected,
          pending: {
            requests: ['one', 'two'].map((id) => ({
              id, sessionId: projected.id, kind: 'permission' as const,
              status: 'pending' as const, createdAt: 2, expiresAt: null, display: {},
            })),
            revision: 4,
          },
        }],
        pendingTotal: 2,
        respondPending,
      }}
      onOpenSession={vi.fn()}
    />);
    fireEvent.click(screen.getByRole('button', { name: /全部拒绝/ }));
    await waitFor(() => expect(respondPending).toHaveBeenCalledTimes(2));
    expect(respondPending.mock.calls.map((call) => [call[0].request.id, call[1]]))
      .toEqual([['one', 'deny'], ['two', 'deny']]);
  });

  it('shows an initial Live read failure instead of an authoritative empty state', () => {
    render(<SessionList remoteSource={{ ...source(), error: '远程 Live 列表读取失败。' }} />);
    expect(screen.getByRole('alert').textContent).toContain('Live 列表读取失败');
    expect(screen.queryByText('还没有远程会话')).toBeNull();
  });
});
