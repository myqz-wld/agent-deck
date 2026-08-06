// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionDetail } from '@renderer/components/SessionDetail';
import type { RemoteSessionSourceView } from './source-types';

afterEach(cleanup);

function remoteSource(): RemoteSessionSourceView {
  const session = {
    id: 'same-session',
    adapterId: 'codex-cli',
    title: 'Remote session',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    busy: false,
    capabilities: new Set([
      'sessions.history',
      'sessions.write',
      'pending.read',
      'pending.respond',
      'sessions.runtime.read',
      'sessions.runtime.write',
    ]),
    error: null,
    history: {
      entries: [{
        id: 'entry-a',
        sessionId: session.id,
        sequence: 1,
        role: 'assistant',
        content: 'remote-only history',
        createdAt: 2,
      }],
      nextCursor: null,
      revision: 2,
    },
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreProjects: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    pendingBySession: new Map(),
    profile: {
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
    },
    projects: [],
    recoveringWorker: false,
    runtime: { adapterId: 'codex-cli', values: { model: 'remote-model' }, revision: 3 },
    sessionTotal: 1,
    selectedPending: { requests: [], revision: 4 },
    selectedSession: session,
    selectedSessionId: session.id,
    sessions: [session],
    state: {
      profileId: 'remote-a',
      status: 'connected',
      recovery: null,
      authoritativeCoreId: 'authoritative-a',
      workerGeneration: null,
      capabilities: [],
      eventRevision: 2,
      error: null,
    },
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

describe('SessionDetail source shell', () => {
  it('renders Remote through the shared shell and never falls back to local-only APIs', () => {
    const localFileChanges = vi.fn();
    window.api = { getFileChanges: localFileChanges } as unknown as typeof window.api;
    render(<SessionDetail remoteSource={remoteSource()} onClose={vi.fn()} />);

    expect(document.querySelectorAll('[data-session-detail-shell]')).toHaveLength(1);
    expect(screen.getByText('Remote session')).toBeTruthy();
    expect(screen.getByText('remote-only history')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '改动' }));
    expect(screen.getByText(/不会回退读取本地工作区/)).toBeTruthy();
    expect(localFileChanges).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '运行时' }));
    expect(screen.getByText(/remote-model/)).toBeTruthy();
  });

  it('hides the old detail and every action while a new session identity is loading', () => {
    const source = remoteSource();
    render(<SessionDetail
      remoteSource={{ ...source, selectedSessionId: 'next-session' }}
      onClose={vi.fn()}
    />);

    expect(screen.getAllByText('正在读取远程 session…')).toHaveLength(2);
    expect(screen.queryByText('Remote session')).toBeNull();
    expect(screen.queryByText('remote-only history')).toBeNull();
    expect(screen.queryByText(/remote-model/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
  });
});
