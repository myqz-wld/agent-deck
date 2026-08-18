// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';
import type { SessionRecord } from '@shared/types';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useSessionStore } from '@renderer/stores/session-store';
import { AppHeader } from '../AppHeader';
import { SessionList } from '../SessionList';

function localSession(
  id: string,
  lifecycle: SessionRecord['lifecycle'],
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo/shared',
    title: `${lifecycle} Local`,
    source: 'sdk',
    lifecycle,
    activity: lifecycle === 'active' ? 'working' : 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    pinnedAt: null,
  } as SessionRecord;
}

function remoteSession(
  id: string,
  lifecycle: RemoteHostSessionPresentationDto['lifecycle'],
  activity: RemoteHostSessionPresentationDto['activity'],
): RemoteHostSessionPresentationDto {
  return {
    id, adapterId: 'codex-cli', title: `${id} Remote`, source: 'sdk', lifecycle, activity,
    archived: lifecycle === 'closed', pinned: false, createdAt: 1, updatedAt: 2,
    endedAt: lifecycle === 'closed' ? 2 : null, model: null, thinking: null,
    runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0, teams: [],
    summary: null, summaryGenerationSource: null, workspaceLabel: null, contextOnly: false,
  };
}

function remoteSource(
  sessions: readonly RemoteHostSessionPresentationDto[],
  overrides: Partial<RemoteSessionSourceView> = {},
): RemoteSessionSourceView {
  return {
    busy: false,
    capabilities: new Set(['sessions.presentation.read']),
    dataRevision: 1,
    error: null,
    eventLoadError: null,
    events: null,
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    pendingBySession: new Map(),
    profile: {
      id: 'remote-a',
      label: 'Production Core',
      scope: 'remote',
      endpoint: null,
    },
    recoveringWorker: false,
    runtime: null,
    summaries: null,
    taskLoadError: null,
    tasks: null,
    sessionTotal: sessions.length,
    selectedPending: null,
    selectedSession: null,
    selectedSessionId: null,
    sessions,
    state: {
      profileId: 'remote-a',
      status: 'connected',
      recovery: null,
      authoritativeCoreId: 'core-a',
      workerGeneration: 1,
      capabilities: ['sessions.presentation.read'],
      eventRevision: 1,
      error: null,
    },
    usable: true,
    clearError: vi.fn(),
    loadMoreHistorySessions: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    refresh: vi.fn(),
    selectSession: vi.fn(),
    ...overrides,
  } as unknown as RemoteSessionSourceView;
}

let getSessionGitBranch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getSessionGitBranch = vi.fn(async () => 'feature/parity');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getSessionGitBranch,
      confirmDialog: vi.fn(async () => true),
      setSessionPinned: vi.fn(async () => undefined),
    },
  });
  useSessionStore.setState({
    sessions: new Map(),
    selectedSessionId: null,
    recentEventsBySession: new Map(),
    latestSummaryBySession: new Map(),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.clearAllMocks();
});

describe('Local and Remote session-list parity', () => {
  it('uses the same card, header, and lifecycle-section structure for equivalent rows', () => {
    const localActive = localSession('local-active', 'active');
    const localDormant = localSession('local-dormant', 'dormant');
    useSessionStore.setState({
      sessions: new Map([
        [localActive.id, localActive],
        [localDormant.id, localDormant],
      ]),
      selectedSessionId: localActive.id,
    });
    const localView = render(<SessionList />);
    const localCard = document.querySelector('[data-session-id="local-active"]')!;
    const localHeader = localCard.querySelector('[data-session-card-header]')!;
    const localActiveSection = document.querySelector('[data-session-section="active"]')!;
    expect(screen.getByText('活跃 · 1')).toBeTruthy();
    expect(screen.getByText('休眠 · 1')).toBeTruthy();

    localView.unmount();
    getSessionGitBranch.mockClear();
    const source = remoteSource([
      remoteSession('remote-active', 'active', 'working'),
      remoteSession('remote-dormant', 'dormant', 'idle'),
    ], { selectedSessionId: 'remote-active' });
    render(<SessionList remoteSource={source} />);
    const remoteCard = document.querySelector('[data-session-id="remote-active"]')!;
    const remoteHeader = remoteCard.querySelector('[data-session-card-header]')!;
    const remoteActiveSection = document.querySelector('[data-session-section="active"]')!;

    expect(remoteCard.className).toBe(localCard.className);
    expect(remoteCard.className).toContain('border-white/30 bg-white/10');
    expect(remoteHeader.className).toBe(localHeader.className);
    expect(remoteActiveSection.className).toBe(localActiveSection.className);
    expect(screen.getByText('活跃 · 1')).toBeTruthy();
    expect(screen.getByText('休眠 · 1')).toBeTruthy();
    expect(remoteCard.querySelector('[title="正在执行"]')).toBeTruthy();
    expect(screen.queryByText('active Local')).toBeNull();
    expect(getSessionGitBranch).not.toHaveBeenCalled();
  });

  it('omits the Remote-only Closed section and decorative profile/count banner', () => {
    const source = remoteSource([
      remoteSession('Active', 'active', 'idle'),
      remoteSession('Closed', 'closed', 'finished'),
    ], { hasMoreSessions: true, sessionTotal: 9 });
    render(<SessionList remoteSource={source} />);

    expect(screen.getByText('Active Remote')).toBeTruthy();
    expect(screen.queryByText('Closed Remote')).toBeNull();
    expect(screen.queryByText(/已关闭/)).toBeNull();
    expect(screen.queryByText(/Production Core/)).toBeNull();
    expect(screen.queryByText(/已载入|1\/9/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开会话 Active Remote' }));
    expect(source.selectSession).toHaveBeenCalledWith('Active');
    fireEvent.click(screen.getByRole('button', { name: '加载更多会话' }));
    expect(source.loadMoreSessions).toHaveBeenCalledOnce();

    cleanup();
    const busySource = remoteSource([
      remoteSession('Active', 'active', 'idle'),
    ], { livePaginationBusy: true, hasMoreSessions: true, sessionTotal: 9 });
    render(<SessionList remoteSource={busySource} />);
    expect((screen.getByRole('button', { name: '加载更多会话' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('uses the shared spawn/team tree and authoritative lifecycle section counts', () => {
    const lead = {
      ...remoteSession('Lead', 'active', 'idle'),
      teams: [{ teamId: 'team-a', teamName: 'Parity Team', role: 'lead' as const, joinedAt: 1 }],
    };
    const child = {
      ...remoteSession('Child', 'active', 'waiting'),
      spawnedBy: lead.id,
      spawnDepth: 1,
      teams: [{ teamId: 'team-a', teamName: 'Parity Team', role: 'teammate' as const, joinedAt: 1 }],
    };
    render(<SessionList remoteSource={remoteSource([lead, child], {
      presentationCounts: {
        total: 5, active: 2, dormant: 3, closed: 0, working: 0, waiting: 1,
      },
      hasMoreSessions: true,
    })} />);
    const active = document.querySelector('[data-session-section="active"]')!;
    expect(active.querySelector('.ml-3 [data-session-id="Child"]')).toBeTruthy();
    expect(screen.getByText('负责人')).toBeTruthy();
    expect(screen.getByText('协作者')).toBeTruthy();
    expect(screen.getByText('活跃 · 2')).toBeTruthy();
    expect(screen.getByText('休眠 · 3')).toBeTruthy();
    expect(screen.getByText(/此分区还有 3 个会话/)).toBeTruthy();
  });

  it('shows an accessible read-only indicator for an authoritative Remote pin', () => {
    const pinned = { ...remoteSession('Pinned', 'active', 'idle'), pinned: true };
    render(<SessionList remoteSource={remoteSource([pinned])} />);

    expect(screen.getByRole('img', { name: '此会话已置顶' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /置顶会话/ })).toBeNull();
  });

  it('opens archive and delete actions from a Remote Live card right click', async () => {
    const archiveHistorySession = vi.fn(async () => undefined);
    const deleteHistorySession = vi.fn(async () => undefined);
    const source = remoteSource([remoteSession('Live', 'active', 'working')], {
      capabilities: new Set(['sessions.presentation.read', 'sessions.history.write']),
      archiveHistorySession,
      deleteHistorySession,
      unarchiveHistorySession: vi.fn(async () => undefined),
    });
    render(<SessionList remoteSource={source} />);

    fireEvent.contextMenu(screen.getByText('Live Remote'), { clientX: 90, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
    await waitFor(() => expect(archiveHistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'Live' }),
    ));

    fireEvent.contextMenu(screen.getByText('Live Remote'), { clientX: 90, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    await waitFor(() => expect(window.api.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: '删除会话', destructive: true }),
    ));
    await waitFor(() => expect(deleteHistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'Live' }),
    ));
  });

  it('offers Remote reactivation only on dormant Live rows when negotiated', async () => {
    const reactivateSession = vi.fn(async () => undefined);
    const source = remoteSource([
      remoteSession('Active', 'active', 'idle'),
      remoteSession('Dormant', 'dormant', 'idle'),
    ], {
      capabilities: new Set([
        'sessions.presentation.read', 'sessions.history.write', 'sessions.reactivate',
      ]),
      archiveHistorySession: vi.fn(async () => undefined),
      deleteHistorySession: vi.fn(async () => undefined),
      reactivateSession,
      unarchiveHistorySession: vi.fn(async () => undefined),
    });
    render(<SessionList remoteSource={source} />);

    fireEvent.contextMenu(screen.getByText('Active Remote'));
    expect(screen.queryByRole('menuitem', { name: '重新激活' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.contextMenu(screen.getByText('Dormant Remote'));
    fireEvent.click(screen.getByRole('menuitem', { name: '重新激活' }));

    await waitFor(() => expect(reactivateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'Dormant', lifecycle: 'dormant' }),
    ));
  });

  it('uses one shared layout grammar for empty, loading, and failed states', () => {
    const localView = render(<SessionList />);
    const localEmpty = document.querySelector('[data-session-list-state="empty"]')!;
    expect(localEmpty.className).toContain('items-center justify-center');
    localView.unmount();

    const remoteView = render(<SessionList remoteSource={remoteSource([])} />);
    const remoteEmpty = document.querySelector('[data-session-list-state="empty"]')!;
    expect(remoteEmpty.className).toBe(localEmpty.className);

    remoteView.rerender(<SessionList remoteSource={remoteSource([], { loading: true })} />);
    expect(document.querySelector('[data-session-list-state="loading"]')?.className)
      .toContain('items-center justify-center');

    remoteView.rerender(<SessionList remoteSource={remoteSource([], {
      error: '远程 Live 列表读取失败。',
    })} />);
    const failed = document.querySelector('[data-session-list-state="error"]')!;
    expect(failed.getAttribute('role')).toBe('alert');
    expect(failed.className).toContain('items-center justify-center');
  });

  it('keeps authoritative Remote totals in the existing app header', () => {
    render(<AppHeader
      view="live"
      stats={{ total: 9, waiting: 1, working: 1 }}
      pending={0}
      pinned={false}
      compact={false}
      authority="remote"
      selectedRemoteProfileId="remote-a"
      remoteProfiles={[]}
      remoteCapabilities={new Set(['sessions.presentation.read'])}
      remoteUsable
      remoteUsage={{
        enabled: true,
        identity: 'remote-a:core-a:1',
        rates: [],
        topToday: [],
        ratesLoading: false,
        ratesError: null,
        today: null,
        daily: [],
        dailyLoading: false,
        dailyError: null,
        dailyTruncated: false,
        providerSnapshots: [],
        providerFetchedAt: null,
        providerLoading: false,
        providerError: null,
        loadDaily: vi.fn(async () => undefined),
        loadProviders: vi.fn(async () => undefined),
      }}
      onViewChange={vi.fn()}
      onSourceChange={vi.fn()}
      onOpenRemoteProfiles={vi.fn()}
      onOpenPending={vi.fn()}
      onNewSession={vi.fn()}
      onTogglePin={vi.fn()}
      onToggleCompact={vi.fn()}
      onOpenLibrary={vi.fn()}
      onOpenSettings={vi.fn()}
    />);

    expect(screen.getByText('9 会话')).toBeTruthy();
    expect(screen.queryByText(/已载入/)).toBeNull();
  });

  it('keeps the bounded 512-row Remote list interactive', () => {
    const rows = Array.from({ length: 512 }, (_, index) =>
      remoteSession(`remote-${index}`, 'active', 'idle'));
    const source = remoteSource(rows);
    render(<SessionList remoteSource={source} />);

    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(512);
    fireEvent.click(screen.getByRole('button', {
      name: '打开会话 remote-511 Remote',
    }));
    expect(source.selectSession).toHaveBeenCalledWith('remote-511');
  });
});
