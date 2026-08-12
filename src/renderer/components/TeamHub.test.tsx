// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useSessionStore } from '@renderer/stores/session-store';
import type { RemoteHostResourceRevisions } from '@shared/remote-host';
import { TeamHub } from './TeamHub';

function resourceRevisions(teams: number): RemoteHostResourceRevisions {
  return {
    'session-list': 0,
    'session-detail': 0,
    pending: 0,
    teams,
    issues: 0,
    usage: 0,
    'node-configuration': 0,
    'node-assets': 0,
  };
}

afterEach(() => {
  cleanup();
  act(() => useSessionStore.setState({ sessions: new Map() }));
  Reflect.deleteProperty(window, 'api');
});

describe('TeamHub failure containment', () => {
  it('renders a stable error when a Remote provider throws before returning a promise', async () => {
    const listRemoteHostTeams = vi.fn(() => {
      throw new Error('transport disappeared');
    });
    window.api = { listRemoteHostTeams } as unknown as typeof window.api;
    const remote = {
      identity: 'remote-a:core-a:1',
      dataRevision: 1,
      resourceRevisions: resourceRevisions(1),
      profile: { id: 'remote-a' },
      usable: true,
    } as unknown as RemoteSessionSourceView;

    render(<TeamHub remoteSource={remote} onOpenSession={vi.fn()} />);

    expect(await screen.findByText('读取团队列表失败，请稍后重试。')).toBeTruthy();
    expect(listRemoteHostTeams).toHaveBeenCalledOnce();
  });

  it('coalesces a Remote revision burst behind one in-flight list request', async () => {
    let resolveInitial!: (value: { teams: []; revision: number }) => void;
    const initial = new Promise<{ teams: []; revision: number }>((resolve) => {
      resolveInitial = resolve;
    });
    const listRemoteHostTeams = vi.fn()
      .mockReturnValueOnce(initial)
      .mockResolvedValue({ teams: [], revision: 101 });
    window.api = { listRemoteHostTeams } as unknown as typeof window.api;
    const remote = (teamsRevision: number, dataRevision = 1) => ({
      identity: 'remote-a:core-a:1',
      dataRevision,
      resourceRevisions: resourceRevisions(teamsRevision),
      profile: { id: 'remote-a' },
      usable: true,
    }) as unknown as RemoteSessionSourceView;
    const view = render(<TeamHub remoteSource={remote(1)} onOpenSession={vi.fn()} />);

    for (let revision = 2; revision <= 101; revision += 1) {
      view.rerender(<TeamHub remoteSource={remote(revision)} onOpenSession={vi.fn()} />);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(listRemoteHostTeams).toHaveBeenCalledOnce();

    resolveInitial({ teams: [], revision: 1 });
    await waitFor(() => expect(listRemoteHostTeams).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('暂无团队')).toBeTruthy();
  });

  it('does not reload a stable Remote team list when unrelated Local sessions change', async () => {
    const listRemoteHostTeams = vi.fn(async () => ({ teams: [], revision: 1 }));
    window.api = { listRemoteHostTeams } as unknown as typeof window.api;
    const remote = {
      identity: 'remote-a:core-a:1',
      dataRevision: 1,
      resourceRevisions: resourceRevisions(1),
      profile: { id: 'remote-a' },
      usable: true,
    } as unknown as RemoteSessionSourceView;
    render(<TeamHub remoteSource={remote} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('暂无团队')).toBeTruthy();
    expect(listRemoteHostTeams).toHaveBeenCalledOnce();

    act(() => useSessionStore.setState({
      sessions: new Map([['local-only', {
        id: 'local-only',
        agentId: 'codex-cli',
        cwd: '/local',
        title: 'Local only',
        source: 'sdk',
        lifecycle: 'active',
        activity: 'working',
        startedAt: 1,
        lastEventAt: 2,
        endedAt: null,
        archivedAt: null,
      }]]),
    }));
    await act(async () => { await Promise.resolve(); });
    expect(listRemoteHostTeams).toHaveBeenCalledOnce();
  });

  it('ignores unrelated global revisions and refreshes only for the Teams lane', async () => {
    const listRemoteHostTeams = vi.fn(async () => ({ teams: [], revision: 1 }));
    window.api = { listRemoteHostTeams } as unknown as typeof window.api;
    const remote = (teams: number, dataRevision: number) => ({
      identity: 'remote-a:core-a:1',
      dataRevision,
      resourceRevisions: resourceRevisions(teams),
      profile: { id: 'remote-a' },
      usable: true,
    }) as unknown as RemoteSessionSourceView;
    const view = render(<TeamHub remoteSource={remote(1, 1)} onOpenSession={vi.fn()} />);
    expect(await screen.findByText('暂无团队')).toBeTruthy();

    view.rerender(<TeamHub remoteSource={remote(1, 99)} onOpenSession={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(listRemoteHostTeams).toHaveBeenCalledOnce();

    view.rerender(<TeamHub remoteSource={remote(2, 100)} onOpenSession={vi.fn()} />);
    await waitFor(() => expect(listRemoteHostTeams).toHaveBeenCalledTimes(2));
  });
});
