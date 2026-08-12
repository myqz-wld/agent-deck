// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TeamDetailDto } from '@contracts/index';
import type { AgentDeckTeam, AgentDeckTeamMember } from '@shared/types';
import type { TeamDataSource } from '../../team-data-source';
import { TeamDetail } from '../index';

vi.mock('../Header', () => ({
  Header: ({
    children,
    actions,
  }: {
    children: React.ReactNode;
    actions?: React.ReactNode;
  }) => <header>{children}{actions}</header>,
}));
vi.mock('../MembersSection', () => ({ MembersSection: () => null }));
vi.mock('../LineageSection', () => ({ LineageSection: () => null }));
vi.mock('../PendingSection', () => ({ PendingSection: () => null }));
vi.mock('../TasksSection', () => ({ TasksSection: () => null }));
vi.mock('../MessagesSection', () => ({ MessagesSection: () => null }));
vi.mock('../EventsSection', () => ({
  EventsSection: ({ events }: { events: Array<{ payload: { text?: string } }> }) => (
    <div>{events[0]?.payload.text}</div>
  ),
}));

afterEach(() => cleanup());

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(
  id: string,
  text: string,
  members: AgentDeckTeamMember[] = [],
): AgentDeckTeam & {
  members: AgentDeckTeamMember[];
  recentEvents: Array<{
    id: number;
    sessionId: string;
    agentId: string;
    kind: 'message';
    payload: { text: string };
    ts: number;
  }>;
  tasks: [];
  recentMessages: [];
} {
  return {
    id,
    name: `Team ${id}`,
    createdAt: 1,
    archivedAt: null,
    archiveReason: null,
    metadata: {},
    members,
    recentEvents: [{
      id: 1,
      sessionId: id,
      agentId: 'claude-code',
      kind: 'message',
      payload: { text },
      ts: 1,
    }],
    tasks: [],
    recentMessages: [],
  };
}

function teammate(teamId: string): AgentDeckTeamMember {
  return {
    teamId,
    sessionId: `${teamId}-teammate`,
    role: 'teammate',
    displayName: `${teamId} collaborator`,
    joinedAt: 1,
    leftAt: null,
  };
}

describe('TeamDetail refresh sequencing', () => {
  it('refreshes a same-identity Remote source without replacing the visible page', async () => {
    const next = deferred<{ team: TeamDetailDto; revision: number }>();
    const row = {
      ...snapshot('A', 'remote event'),
      sessions: [],
      pending: [],
    } as unknown as TeamDetailDto;
    const get = vi.fn()
      .mockResolvedValueOnce({ team: row, revision: 1 })
      .mockReturnValueOnce(next.promise);
    const source = (revision: number): TeamDataSource => ({
      identity: 'remote-a:core-a:1',
      revision,
      isUsable: () => true,
      list: vi.fn(),
      get,
      archive: vi.fn(),
      addMember: vi.fn(),
      shutdownTeammates: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    });
    const view = render(
      <TeamDetail
        teamId="A"
        source={source(1)}
        onBack={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    await screen.findByText('Team A');

    view.rerender(
      <TeamDetail
        teamId="A"
        source={source(2)}
        onBack={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Team A')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();

    next.resolve({ team: row, revision: 2 });
    await waitFor(() => expect(screen.getByText('remote event')).toBeTruthy());
  });

  it('uses a fixed retryable snapshot error without backend details', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAgentDeckTeamFull: vi.fn().mockRejectedValue(new Error('private database detail')),
        onAgentDeckTeamChanged: vi.fn(() => vi.fn()),
        onAgentDeckMessageChanged: vi.fn(() => vi.fn()),
      },
    });
    render(<TeamDetail teamId="A" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('读取团队详情失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('private database detail');
  });

  it('scopes invalidation by team, coalesces bursts, and fences a stale team switch', async () => {
    const teamA = deferred<ReturnType<typeof snapshot> | null>();
    const teamB = deferred<ReturnType<typeof snapshot> | null>();
    const callbacks: {
      team?: (items: Array<{ teamId: string }>) => void;
      message?: (items: Array<{ teamId: string | null }>) => void;
    } = {};
    const getFull = vi.fn((teamId: string) => {
      if (teamId === 'A') return teamA.promise;
      return teamB.promise;
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAgentDeckTeamFull: getFull,
        onAgentDeckTeamChanged: vi.fn((callback) => {
          callbacks.team = callback;
          return vi.fn();
        }),
        onAgentDeckMessageChanged: vi.fn((callback) => {
          callbacks.message = callback;
          return vi.fn();
        }),
      },
    });
    const { rerender } = render(
      <TeamDetail teamId="A" onBack={vi.fn()} onOpenSession={vi.fn()} />,
    );
    rerender(<TeamDetail teamId="B" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    callbacks.team?.([{ teamId: 'A' }]);
    callbacks.message?.([{ teamId: 'other' }]);
    expect(getFull.mock.calls.map(([teamId]) => teamId)).toEqual(['A', 'B']);

    teamA.resolve(snapshot('A', 'stale A event'));
    teamB.resolve(snapshot('B', 'current B event'));
    await waitFor(() => expect(screen.getByText('current B event')).toBeTruthy());
    expect(screen.queryByText('stale A event')).toBeNull();

    const inFlightRefresh = deferred<ReturnType<typeof snapshot> | null>();
    getFull.mockImplementationOnce(() => inFlightRefresh.promise);
    callbacks.team?.([{ teamId: 'B' }]);
    callbacks.team?.([{ teamId: 'B' }, { teamId: 'B' }]);
    expect(getFull).toHaveBeenCalledTimes(3);
    inFlightRefresh.resolve(snapshot('B', 'refreshed B event'));
    await waitFor(() => expect(getFull).toHaveBeenCalledTimes(4));
  });

  it('abandons an A confirmation after switching to B', async () => {
    const confirmation = deferred<boolean>();
    const shutdown = vi.fn().mockResolvedValue({ failed: [] });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAgentDeckTeamFull: vi.fn((teamId: string) => Promise.resolve(
          teamId === 'A'
            ? snapshot('A', 'A event', [teammate('A')])
            : snapshot('B', 'B event'),
        )),
        onAgentDeckTeamChanged: vi.fn(() => vi.fn()),
        onAgentDeckMessageChanged: vi.fn(() => vi.fn()),
        confirmDialog: vi.fn(() => confirmation.promise),
        shutdownAllTeammates: shutdown,
      },
    });
    const view = render(<TeamDetail teamId="A" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText('Team A');
    fireEvent.click(screen.getByRole('button', { name: '关闭 1 个协作者' }));
    view.rerender(<TeamDetail teamId="B" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText('Team B');
    confirmation.resolve(true);
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('abandons a Remote confirmation when the source becomes unusable', async () => {
    const confirmation = deferred<boolean>();
    const shutdown = vi.fn().mockResolvedValue({ failed: [] });
    let usable = true;
    const row = {
      ...snapshot('A', 'remote event', [teammate('A')]),
      sessions: [],
      pending: [],
    } as unknown as TeamDetailDto;
    const source: TeamDataSource = {
      identity: 'remote-a:core-a:1',
      revision: 1,
      isUsable: () => usable,
      list: vi.fn(),
      get: vi.fn().mockResolvedValue({ team: row, revision: 1 }),
      archive: vi.fn(),
      addMember: vi.fn(),
      shutdownTeammates: shutdown,
      subscribe: vi.fn(() => vi.fn()),
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { confirmDialog: vi.fn(() => confirmation.promise) },
    });

    render(
      <TeamDetail teamId="A" source={source} onBack={vi.fn()} onOpenSession={vi.fn()} />,
    );
    await screen.findByText('Team A');
    fireEvent.click(screen.getByRole('button', { name: '关闭 1 个协作者' }));
    usable = false;
    confirmation.resolve(true);
    await Promise.resolve();

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('does not let an A completion clear B action state', async () => {
    const shutdown = deferred<{ failed: string[] }>();
    const archive = deferred<void>();
    const shutdownAllTeammates = vi.fn(() => shutdown.promise);
    const archiveAgentDeckTeam = vi.fn(() => archive.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAgentDeckTeamFull: vi.fn((teamId: string) => Promise.resolve(
          teamId === 'A'
            ? snapshot('A', 'A event', [teammate('A')])
            : snapshot('B', 'B event'),
        )),
        onAgentDeckTeamChanged: vi.fn(() => vi.fn()),
        onAgentDeckMessageChanged: vi.fn(() => vi.fn()),
        confirmDialog: vi.fn().mockResolvedValue(true),
        shutdownAllTeammates,
        archiveAgentDeckTeam,
      },
    });
    const view = render(<TeamDetail teamId="A" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText('Team A');
    fireEvent.click(screen.getByRole('button', { name: '关闭 1 个协作者' }));
    await waitFor(() => expect(shutdownAllTeammates).toHaveBeenCalledWith('A'));

    view.rerender(<TeamDetail teamId="B" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText('Team B');
    const archiveButton = screen.getByRole('button', { name: '归档' });
    expect((archiveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(archiveButton);
    await screen.findByRole('button', { name: '归档中…' });

    shutdown.resolve({ failed: [] });
    await Promise.resolve();
    expect(screen.getByRole('button', { name: '归档中…' })).toBeTruthy();
    archive.resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: '归档' })).toBeTruthy());
  });

  it('shows fixed shutdown and archive failures without backend details or failed ids', async () => {
    const shutdownAllTeammates = vi.fn()
      .mockRejectedValueOnce(new Error('shutdown transport detail'))
      .mockResolvedValueOnce({ failed: ['hidden-session-id'] });
    const archiveAgentDeckTeam = vi.fn().mockRejectedValue(
      new Error('archive storage detail'),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAgentDeckTeamFull: vi.fn().mockResolvedValue(
          snapshot('A', 'A event', [teammate('A')]),
        ),
        onAgentDeckTeamChanged: vi.fn(() => vi.fn()),
        onAgentDeckMessageChanged: vi.fn(() => vi.fn()),
        confirmDialog: vi.fn().mockResolvedValue(true),
        shutdownAllTeammates,
        archiveAgentDeckTeam,
      },
    });

    render(<TeamDetail teamId="A" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText('Team A');

    fireEvent.click(screen.getByRole('button', { name: '关闭 1 个协作者' }));
    expect(await screen.findByText('关闭协作者失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('shutdown transport detail');

    fireEvent.click(screen.getByRole('button', { name: '关闭 1 个协作者' }));
    expect(await screen.findByText('部分协作者未能关闭，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('hidden-session-id');

    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(await screen.findByText('归档团队失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('archive storage detail');
  });

  it('does not let a stale A action error paint team B', async () => {
    let rejectShutdown!: (reason: unknown) => void;
    const shutdown = new Promise<{ failed: string[] }>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    const shutdownAllTeammates = vi.fn(() => shutdown);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAgentDeckTeamFull: vi.fn((teamId: string) => Promise.resolve(
          teamId === 'A'
            ? snapshot('A', 'A event', [teammate('A')])
            : snapshot('B', 'B event'),
        )),
        onAgentDeckTeamChanged: vi.fn(() => vi.fn()),
        onAgentDeckMessageChanged: vi.fn(() => vi.fn()),
        confirmDialog: vi.fn().mockResolvedValue(true),
        shutdownAllTeammates,
      },
    });
    const view = render(<TeamDetail teamId="A" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText('Team A');
    fireEvent.click(screen.getByRole('button', { name: '关闭 1 个协作者' }));
    await waitFor(() => expect(shutdownAllTeammates).toHaveBeenCalledWith('A'));

    view.rerender(<TeamDetail teamId="B" onBack={vi.fn()} onOpenSession={vi.fn()} />);
    await screen.findByText('Team B');
    rejectShutdown(new Error('stale A failure'));
    await Promise.resolve();

    expect(screen.queryByText('关闭协作者失败，请稍后重试。')).toBeNull();
    expect(document.body.textContent).not.toContain('stale A failure');
  });
});
