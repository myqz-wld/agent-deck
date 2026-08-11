// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { useSessionStore } from '@renderer/stores/session-store';
import { TeamHub } from './TeamHub';

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
      profile: { id: 'remote-a' },
      usable: true,
    } as unknown as RemoteSessionSourceView;

    render(<TeamHub remoteSource={remote} onOpenSession={vi.fn()} />);

    expect(await screen.findByText('读取团队列表失败，请稍后重试。')).toBeTruthy();
    expect(listRemoteHostTeams).toHaveBeenCalledOnce();
  });

  it('does not reload a stable Remote team list when unrelated Local sessions change', async () => {
    const listRemoteHostTeams = vi.fn(async () => ({ teams: [], revision: 1 }));
    window.api = { listRemoteHostTeams } as unknown as typeof window.api;
    const remote = {
      identity: 'remote-a:core-a:1',
      dataRevision: 1,
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
});
