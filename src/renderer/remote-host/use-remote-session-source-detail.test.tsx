// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPermissionPreviewDisplay } from '@contracts/index';
import type {
  RemoteHostSessionPresentationDto,
  RemoteHostSessionPresentationPageDto,
} from '@shared/remote-host';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import { remotePendingPresentation } from './remote-pending-presentation';
import { useRemoteSessionSource } from './use-remote-session-source';
import {
  deferred,
  hosts as fixtureHosts,
  session,
} from './use-remote-session-source-test-fixture';

function sessionPresentation(
  id: string,
  title: string,
  lifecycle: RemoteHostSessionPresentationDto['lifecycle'] = 'active',
  activity: RemoteHostSessionPresentationDto['activity'] = 'idle',
): RemoteHostSessionPresentationDto {
  return {
    id, adapterId: 'codex-cli', title, source: 'sdk', lifecycle, activity,
    archived: lifecycle === 'closed', pinned: false, createdAt: 1, updatedAt: 2,
    endedAt: lifecycle === 'closed' ? 2 : null, model: null, thinking: null,
    runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0, teams: [],
    summary: null, summaryGenerationSource: null, workspaceLabel: null, contextOnly: false,
  };
}

function presentationPage(
  title: string,
  revision: number,
  kind: 'history' | 'live' = 'live',
): RemoteHostSessionPresentationPageDto {
  const sessions = kind === 'live' ? [sessionPresentation('same-session', title)] : [];
  return {
    sessions,
    nextCursor: null,
    counts: {
      total: sessions.length, active: sessions.length, dormant: 0, closed: 0,
      working: 0, waiting: 0,
    },
    contextTruncated: false,
    revision,
  };
}

function currentHosts(profileId: string | null, dataRevision: number): RemoteHostSnapshotState {
  const current = fixtureHosts(profileId, dataRevision);
  if (!profileId || !current.snapshot) return current;
  current.snapshot.states = current.snapshot.states.map((state) => state.profileId === profileId
    ? {
        ...state,
        capabilities: [...new Set([
          ...state.capabilities,
          'sessions.input.read',
          'sessions.presentation.read',
        ])],
      }
    : state);
  return current;
}

describe('useRemoteSessionSource detail and mutation fencing', () => {
  const oldDetail = deferred<ReturnType<typeof session>>();
  beforeEach(() => {
    window.api = {
      listRemoteHostSessionPresentations: vi.fn(async (request) =>
        presentationPage(`${request.profileId} list`, 1, request.kind)),
      listRemoteHostProjects: vi.fn(async () => ({
        projects: [], nextCursor: null, total: 0, revision: 1,
      })),
      listRemoteHostPending: vi.fn(async (request) => ({
        requests: [{
          id: 'same-request',
          sessionId: 'same-session',
          kind: 'permission',
          status: 'pending',
          createdAt: 1,
          expiresAt: null,
          display: createPermissionPreviewDisplay('Bash', {
            command: 'pwd', source: request.profileId,
          }),
        }],
        revision: request.profileId === 'remote-a' ? 10 : 20,
      })),
      listRemoteHostPendingIndex: vi.fn(async (request) => {
        const revision = request.profileId === 'remote-a' ? 10 : 20;
        return {
          buckets: [{
            session: sessionPresentation('same-session', `${request.profileId} list`),
            pending: {
              requests: [{
                id: 'same-request', sessionId: 'same-session', kind: 'permission',
                status: 'pending', createdAt: 1, expiresAt: null,
                display: createPermissionPreviewDisplay('Bash', {
                  command: 'pwd', source: request.profileId,
                }),
              }],
              revision,
            },
          }],
          nextCursor: null,
          totalBuckets: 1,
          totalRequests: 1,
          scanTruncated: false,
          revision,
        };
      }),
      getRemoteHostSession: vi.fn((request) => request.profileId === 'remote-a'
        ? oldDetail.promise
        : Promise.resolve({
            id: 'same-session',
            adapterId: 'codex-cli',
            title: 'remote-b detail',
            status: 'active-idle',
            createdAt: 1,
            updatedAt: 3,
          })),
      listRemoteHostHistory: vi.fn(async () => ({ entries: [], nextCursor: null, revision: 1 })),
      listRemoteHostEvents: vi.fn(async () => ({
        events: [], revision: 1, truncated: false,
      })),
      getRemoteHostRuntime: vi.fn(async () => ({
        adapterId: 'codex-cli', values: {}, revision: 1,
      })),
      getRemoteHostSessionInputCapabilities: vi.fn(async () => ({
        adapterId: 'codex-cli',
        activeTurn: {
          mode: 'steer',
          attachments: {
            disabledReason: 'test fixture has no active attachment input',
            enabled: false,
            maxBytesEach: 2_097_152,
            maxBytesTotal: 8_388_608,
            maxCount: 4,
            mimeTypes: ['image/png'],
          },
        },
        commands: [],
        revision: 1,
      })),
      listRemoteHostSummaries: vi.fn(async () => ({ summaries: [], revision: 1 })),
      listRemoteHostTasks: vi.fn(async () => ({ tasks: [], revision: 1 })),
      listRemoteHostFileChanges: vi.fn(async () => ({
        items: [], nextCursor: null, revision: 1,
      })),
      getRemoteHostFileChange: vi.fn(async () => ({ change: null, revision: 1 })),
      getRemoteHostFileFinalDiff: vi.fn(async (request) => ({
        fileDiff: {
          ok: false,
          filePath: request.filePath,
          diff: null,
          source: 'recorded-snapshot',
          reason: 'unchanged',
        },
        revision: 1,
      })),
      loadRemoteHostImageAsset: vi.fn(async () => ({
        ok: true, dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', bytes: 1,
      })),
      getRemoteHostSessionCapabilities: vi.fn(),
      listRemoteHostWorkspaceDirectories: vi.fn(),
      sendRemoteHostMessage: vi.fn(async () => ({
        messageId: 'message-a', sequence: 1, revision: 2,
      })),
      respondRemoteHostPending: vi.fn(async () => ({ revision: 11 })),
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
  });

  it('clears an old detail immediately and ignores its late same-source refresh', async () => {
    const staleA = deferred<ReturnType<typeof session> | null>();
    const nextB = deferred<ReturnType<typeof session> | null>();
    let aLoads = 0;
    vi.mocked(window.api.getRemoteHostSession).mockImplementation((request) => {
      if (request.sessionId === 'session-a') {
        aLoads += 1;
        return aLoads === 1 ? Promise.resolve(session('session-a', 'session A')) : staleA.promise;
      }
      return nextB.promise;
    });
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('session-a'));
    await waitFor(() => expect(hook.result.current.selectedSession?.title).toBe('session A'));

    hook.rerender({ value: currentHosts('remote-a', 2) });
    await waitFor(() => expect(aLoads).toBe(2));
    act(() => hook.result.current.selectSession('session-b'));
    expect(hook.result.current.selectedSessionId).toBe('session-b');
    expect(hook.result.current.selectedSession).toBeNull();
    expect(hook.result.current.events).toBeNull();
    expect(hook.result.current.runtime).toBeNull();
    expect(hook.result.current.selectedPending).toBeNull();

    nextB.resolve(session('session-b', 'session B'));
    await waitFor(() => expect(hook.result.current.selectedSession?.title).toBe('session B'));
    staleA.resolve(session('session-a', 'stale session A'));
    await act(async () => { await staleA.promise; });
    expect(hook.result.current.selectedSession?.title).toBe('session B');
  });

  it('keeps failed and missing replacement details from exposing the old session', async () => {
    vi.mocked(window.api.getRemoteHostSession).mockImplementation(async (request) => {
      if (request.sessionId === 'session-a') return session('session-a', 'session A');
      if (request.sessionId === 'failed-session') throw new Error('replacement failed');
      return null;
    });
    const hook = renderHook(() => useRemoteSessionSource(currentHosts('remote-a', 1)));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('session-a'));
    await waitFor(() => expect(hook.result.current.selectedSession?.title).toBe('session A'));

    act(() => hook.result.current.selectSession('failed-session'));
    await waitFor(() => expect(hook.result.current.error).toBe('replacement failed'));
    expect(hook.result.current.selectedSessionId).toBe('failed-session');
    expect(hook.result.current.selectedSession).toBeNull();
    expect(hook.result.current.events).toBeNull();
    expect(hook.result.current.runtime).toBeNull();

    act(() => hook.result.current.selectSession('missing-session'));
    await waitFor(() => expect(hook.result.current.error).toBe('远程 session 不存在或已删除。'));
    expect(hook.result.current.selectedSessionId).toBeNull();
    expect(hook.result.current.selectedSession).toBeNull();
    expect(hook.result.current.events).toBeNull();
    expect(hook.result.current.runtime).toBeNull();
  });

  it('submits the revision captured by the pending presentation', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.pendingBySession.get('same-session')?.revision)
      .toBe(10));
    const original = hook.result.current.pendingBySession.get('same-session')!;
    const presentation = remotePendingPresentation(
      hook.result.current.identity,
      original.revision,
      original.requests[0]!,
    );
    vi.mocked(window.api.listRemoteHostPendingIndex).mockResolvedValue({
      buckets: [{
        session: sessionPresentation('same-session', 'remote-a list'),
        pending: { requests: original.requests, revision: 11 },
      }],
      nextCursor: null,
      totalBuckets: 1,
      totalRequests: original.requests.length,
      scanTruncated: false,
      revision: 11,
    });
    hook.rerender({ value: currentHosts('remote-a', 2) });
    await waitFor(() => expect(hook.result.current.pendingBySession.get('same-session')?.revision)
      .toBe(11));

    await act(async () => {
      await hook.result.current.respondPending(presentation, 'approve');
    });
    expect(window.api.respondRemoteHostPending).toHaveBeenCalledWith(expect.objectContaining({
      expectedPresentationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      expectedRevision: 10,
      requestId: 'same-request',
    }));

    hook.rerender({ value: currentHosts('remote-b', 3) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    await act(async () => {
      await expect(hook.result.current.respondPending(presentation, 'approve'))
        .rejects.toThrow('待处理展示已切换');
    });
    expect(window.api.respondRemoteHostPending).toHaveBeenCalledTimes(1);
  });

  it('publishes session rows before bounded pending hydration finishes', async () => {
    const pending = deferred<Awaited<ReturnType<typeof window.api.listRemoteHostPendingIndex>>>();
    vi.mocked(window.api.listRemoteHostPendingIndex).mockImplementation(() => pending.promise);
    const hook = renderHook(() => useRemoteSessionSource(currentHosts('remote-a', 1)));

    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-a list'));
    expect(hook.result.current.pendingBySession.has('same-session')).toBe(false);

    pending.resolve({
      buckets: [{
        session: sessionPresentation('same-session', 'remote-a list'),
        pending: { requests: [], revision: 9 },
      }],
      nextCursor: null,
      totalBuckets: 1,
      totalRequests: 0,
      scanTruncated: false,
      revision: 9,
    });
    await waitFor(() => expect(hook.result.current.pendingBySession.get('same-session'))
      .toEqual({ requests: [], revision: 9 }));
  });

  it('reuses a send intent after timeout and rotates it after a confirmed success', async () => {
    const send = vi.mocked(window.api.sendRemoteHostMessage);
    send.mockRejectedValueOnce(new Error('deadline exceeded'));
    const hook = renderHook(() => useRemoteSessionSource(currentHosts('remote-a', 1)));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));

    await act(async () => {
      await expect(hook.result.current.send('same text')).rejects.toThrow('deadline exceeded');
    });
    await act(async () => { await hook.result.current.send('same text'); });
    await act(async () => { await hook.result.current.send('same text'); });

    const intentIds = send.mock.calls.map(([request]) => request.intentId);
    expect(intentIds[0]).toBe(intentIds[1]);
    expect(intentIds[2]).not.toBe(intentIds[1]);
  });

  it('uses explicit cursors to append bounded remote pages without replacing prior rows', async () => {
    vi.mocked(window.api.listRemoteHostSessionPresentations).mockImplementation(async (request) => {
      if (request.kind === 'history') return presentationPage('', 1, 'history');
      const row = request.cursor
        ? sessionPresentation('session-b', 'second page', 'dormant', 'finished')
        : sessionPresentation('session-a', 'first page');
      return {
        sessions: [row],
        nextCursor: request.cursor ? null : 'next-live',
        counts: {
          total: 2, active: 1, dormant: 1, closed: 0, working: 0, waiting: 0,
        },
        contextTruncated: false,
        revision: 1,
      };
    });
    const hook = renderHook(() => useRemoteSessionSource(currentHosts('remote-a', 1)));
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('first page'));
    expect(hook.result.current.hasMoreSessions).toBe(true);
    expect(hook.result.current.sessionTotal).toBe(2);
    expect(hook.result.current.presentationCounts).toEqual({
      total: 2, active: 1, dormant: 1, closed: 0, working: 0, waiting: 0,
    });

    await act(async () => { await hook.result.current.loadMoreSessions(); });

    expect(hook.result.current.sessions.map((session) => session.title)).toEqual([
      'first page',
      'second page',
    ]);
    expect(hook.result.current.sessions.map((session) => session.lifecycle)).toEqual([
      'active',
      'dormant',
    ]);
    expect(hook.result.current.presentationCounts).toEqual({
      total: 2, active: 1, dormant: 1, closed: 0, working: 0, waiting: 0,
    });
    expect(hook.result.current.hasMoreSessions).toBe(false);
    expect(hook.result.current.sessionTotal).toBe(2);
    expect(window.api.listRemoteHostSessionPresentations).toHaveBeenCalledWith({
      profileId: 'remote-a',
      limit: 40,
      cursor: 'next-live',
      kind: 'live',
    });
  });

});
