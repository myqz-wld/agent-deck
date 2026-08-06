// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteHostProfileDto,
  RemoteHostSnapshotDto,
  RemoteHostStateDto,
} from '@shared/remote-host';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import { remotePendingPresentation } from './remote-pending-presentation';
import { useRemoteSessionSource } from './use-remote-session-source';

const CAPABILITIES = [
  'projects.read',
  'session-console.read',
  'sessions.history',
  'sessions.write',
  'pending.read',
  'pending.respond',
  'sessions.runtime.read',
  'sessions.runtime.write',
];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, reject, resolve };
}

function session(id: string, title: string) {
  return {
    id,
    adapterId: 'codex-cli',
    title,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
  };
}

function profile(id: string): RemoteHostProfileDto {
  return {
    id,
    label: id,
    scope: 'remote',
    endpoint: {
      hostname: `${id}.example.test`,
      port: 22,
      username: 'agentdeck',
      hostKeyFingerprint: 'SHA256:test',
    },
    credentials: { connectionCredentialConfigured: true },
  };
}

function state(id: string): RemoteHostStateDto {
  return {
    profileId: id,
    status: 'connected',
    recovery: null,
    authoritativeCoreId: `core-${id}`,
    workerGeneration: null,
    capabilities: CAPABILITIES,
    eventRevision: 1,
    error: null,
  };
}

function hosts(profileId: string | null, dataRevision: number): RemoteHostSnapshotState {
  const remoteProfiles = [profile('remote-a'), profile('remote-b')];
  const snapshot: RemoteHostSnapshotDto = profileId
    ? {
        revision: dataRevision,
        sourceMode: 'remote',
        selectedRemoteProfileId: profileId,
        profiles: remoteProfiles,
        states: remoteProfiles.map((item) => state(item.id)),
      }
    : {
        revision: dataRevision,
        sourceMode: 'local',
        selectedRemoteProfileId: 'remote-a',
        profiles: remoteProfiles,
        states: remoteProfiles.map((item) => state(item.id)),
      };
  return {
    snapshot,
    dataRevisionByProfile: new Map(profileId ? [[profileId, dataRevision]] : []),
    busy: false,
    error: null,
    refresh: vi.fn(),
    addProfile: vi.fn(),
    updateProfile: vi.fn(),
    removeProfile: vi.fn(),
    selectProfile: vi.fn(),
    setSourceMode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearError: vi.fn(),
  };
}

describe('useRemoteSessionSource source fencing', () => {
  const oldDetail = deferred<{
    id: string;
    adapterId: string;
    title: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  }>();

  beforeEach(() => {
    window.api = {
      listRemoteHostSessions: vi.fn(async (request) => ({
        sessions: request.includeArchived ? [] : [{
          id: 'same-session',
          adapterId: 'codex-cli',
          title: `${request.profileId} list`,
          status: 'active',
          createdAt: 1,
          updatedAt: 2,
        }],
        nextCursor: null,
        total: request.includeArchived ? 0 : 1,
        revision: 1,
      })),
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
          display: { source: request.profileId },
        }],
        revision: request.profileId === 'remote-a' ? 10 : 20,
      })),
      getRemoteHostSession: vi.fn((request) => request.profileId === 'remote-a'
        ? oldDetail.promise
        : Promise.resolve({
            id: 'same-session',
            adapterId: 'codex-cli',
            title: 'remote-b detail',
            status: 'active',
            createdAt: 1,
            updatedAt: 3,
          })),
      listRemoteHostHistory: vi.fn(async () => ({ entries: [], nextCursor: null, revision: 1 })),
      getRemoteHostRuntime: vi.fn(async () => ({
        adapterId: 'codex-cli', values: {}, revision: 1,
      })),
      sendRemoteHostMessage: vi.fn(async () => ({
        messageId: 'message-a', sequence: 1, revision: 2,
      })),
      respondRemoteHostPending: vi.fn(async () => ({ revision: 11 })),
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
  });

  it('isolates identical session and pending ids and drops the old source response', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-a list'));
    expect(hook.result.current.pendingBySession.get('same-session')).toMatchObject({
      revision: 10,
      requests: [{ display: { source: 'remote-a' } }],
    });
    const listCallsBeforeUnrelatedEvent = vi.mocked(window.api.listRemoteHostSessions).mock.calls.length;
    hook.rerender({
      value: {
        ...hosts('remote-a', 1),
        dataRevisionByProfile: new Map([
          ['remote-a', 1],
          ['remote-b', 99],
        ]),
      },
    });
    await act(async () => { await Promise.resolve(); });
    expect(window.api.listRemoteHostSessions).toHaveBeenCalledTimes(
      listCallsBeforeUnrelatedEvent,
    );

    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(window.api.getRemoteHostSession).toHaveBeenCalledWith({
      profileId: 'remote-a', sessionId: 'same-session',
    }));

    hook.rerender({ value: hosts('remote-b', 2) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    expect(hook.result.current.selectedSessionId).toBeNull();
    expect(window.api.getRemoteHostSession).toHaveBeenCalledTimes(1);
    expect(hook.result.current.pendingBySession.get('same-session')).toMatchObject({
      revision: 20,
      requests: [{ display: { source: 'remote-b' } }],
    });

    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(hook.result.current.selectedSession?.title).toBe('remote-b detail'));
    oldDetail.resolve({
      id: 'same-session',
      adapterId: 'codex-cli',
      title: 'late remote-a detail',
      status: 'active',
      createdAt: 1,
      updatedAt: 4,
    });
    await act(async () => { await oldDetail.promise; });
    expect(hook.result.current.selectedSession?.title).toBe('remote-b detail');
  });

  it('keeps at most one list refresh in flight and merges later invalidations', async () => {
    const firstPage = deferred<{
      sessions: Array<{
        id: string;
        adapterId: string;
        title: string;
        status: string;
        createdAt: number;
        updatedAt: number;
      }>;
      nextCursor: null;
      total: number;
      revision: number;
    }>();
    let liveCalls = 0;
    vi.mocked(window.api.listRemoteHostSessions).mockImplementation(async (request) => {
      if (!request.includeArchived && liveCalls++ === 0) return firstPage.promise;
      return {
        sessions: request.includeArchived ? [] : [{
          id: 'same-session',
          adapterId: 'codex-cli',
          title: 'refreshed',
          status: 'active',
          createdAt: 1,
          updatedAt: 3,
        }],
        nextCursor: null,
        total: request.includeArchived ? 0 : 1,
        revision: 2,
      };
    });
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(liveCalls).toBe(1));

    hook.rerender({ value: hosts('remote-a', 2) });
    hook.rerender({ value: hosts('remote-a', 3) });
    await act(async () => { await Promise.resolve(); });
    expect(liveCalls).toBe(1);

    firstPage.resolve({
      sessions: [{
        id: 'same-session',
        adapterId: 'codex-cli',
        title: 'initial',
        status: 'active',
        createdAt: 1,
        updatedAt: 2,
      }],
      nextCursor: null,
      total: 1,
      revision: 1,
    });
    await waitFor(() => expect(liveCalls).toBe(2));
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('refreshed'));
    expect(liveCalls).toBe(2);
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
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('session-a'));
    await waitFor(() => expect(hook.result.current.selectedSession?.title).toBe('session A'));

    hook.rerender({ value: hosts('remote-a', 2) });
    await waitFor(() => expect(aLoads).toBe(2));
    act(() => hook.result.current.selectSession('session-b'));
    expect(hook.result.current.selectedSessionId).toBe('session-b');
    expect(hook.result.current.selectedSession).toBeNull();
    expect(hook.result.current.history).toBeNull();
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
    const hook = renderHook(() => useRemoteSessionSource(hosts('remote-a', 1)));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('session-a'));
    await waitFor(() => expect(hook.result.current.selectedSession?.title).toBe('session A'));

    act(() => hook.result.current.selectSession('failed-session'));
    await waitFor(() => expect(hook.result.current.error).toBe('replacement failed'));
    expect(hook.result.current.selectedSessionId).toBe('failed-session');
    expect(hook.result.current.selectedSession).toBeNull();
    expect(hook.result.current.history).toBeNull();
    expect(hook.result.current.runtime).toBeNull();

    act(() => hook.result.current.selectSession('missing-session'));
    await waitFor(() => expect(hook.result.current.error).toBe('远程 session 不存在或已删除。'));
    expect(hook.result.current.selectedSessionId).toBeNull();
    expect(hook.result.current.selectedSession).toBeNull();
    expect(hook.result.current.history).toBeNull();
    expect(hook.result.current.runtime).toBeNull();
  });

  it('submits the revision captured by the pending presentation', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.pendingBySession.get('same-session')?.revision)
      .toBe(10));
    const original = hook.result.current.pendingBySession.get('same-session')!;
    const presentation = remotePendingPresentation(
      hook.result.current.identity,
      original.revision,
      original.requests[0]!,
    );
    vi.mocked(window.api.listRemoteHostPending).mockResolvedValue({
      requests: original.requests,
      revision: 11,
    });
    hook.rerender({ value: hosts('remote-a', 2) });
    await waitFor(() => expect(hook.result.current.pendingBySession.get('same-session')?.revision)
      .toBe(11));

    await act(async () => {
      await hook.result.current.respondPending(presentation, 'approve');
    });
    expect(window.api.respondRemoteHostPending).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 10,
      requestId: 'same-request',
    }));

    hook.rerender({ value: hosts('remote-b', 3) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    await act(async () => {
      await expect(hook.result.current.respondPending(presentation, 'approve'))
        .rejects.toThrow('待处理展示已切换');
    });
    expect(window.api.respondRemoteHostPending).toHaveBeenCalledTimes(1);
  });

  it('publishes session rows before bounded pending hydration finishes', async () => {
    const pending = deferred<{
      requests: [];
      revision: number;
    }>();
    vi.mocked(window.api.listRemoteHostPending).mockImplementation(() => pending.promise);
    const hook = renderHook(() => useRemoteSessionSource(hosts('remote-a', 1)));

    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-a list'));
    expect(hook.result.current.pendingBySession.has('same-session')).toBe(false);

    pending.resolve({ requests: [], revision: 9 });
    await waitFor(() => expect(hook.result.current.pendingBySession.get('same-session'))
      .toEqual({ requests: [], revision: 9 }));
  });

  it('reuses a send intent after timeout and rotates it after a confirmed success', async () => {
    const send = vi.mocked(window.api.sendRemoteHostMessage);
    send.mockRejectedValueOnce(new Error('deadline exceeded'));
    const hook = renderHook(() => useRemoteSessionSource(hosts('remote-a', 1)));
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
    vi.mocked(window.api.listRemoteHostSessions).mockImplementation(async (request) => ({
      sessions: request.includeArchived
        ? []
        : [{
            id: request.cursor ? 'session-b' : 'session-a',
            adapterId: 'codex-cli',
            title: request.cursor ? 'second page' : 'first page',
            status: 'active',
            createdAt: 1,
            updatedAt: request.cursor ? 3 : 2,
          }],
      nextCursor: !request.includeArchived && !request.cursor ? 'next-live' : null,
      total: request.includeArchived ? 0 : 2,
      revision: 1,
    }));
    const hook = renderHook(() => useRemoteSessionSource(hosts('remote-a', 1)));
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('first page'));
    expect(hook.result.current.hasMoreSessions).toBe(true);
    expect(hook.result.current.sessionTotal).toBe(2);

    await act(async () => { await hook.result.current.loadMoreSessions(); });

    expect(hook.result.current.sessions.map((session) => session.title)).toEqual([
      'first page',
      'second page',
    ]);
    expect(hook.result.current.hasMoreSessions).toBe(false);
    expect(hook.result.current.sessionTotal).toBe(2);
    expect(window.api.listRemoteHostSessions).toHaveBeenCalledWith({
      profileId: 'remote-a',
      limit: 40,
      cursor: 'next-live',
      includeArchived: false,
    });
  });
});
