// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import type {
  RemoteHostConnectionStatus,
  RemoteHostSessionPageDto,
} from '@shared/remote-host';
import { legacyRemoteSessionPresentation } from './session-summary-presentation';
import { remoteSourceIdentity } from './remote-source-utils';
import { useRemoteSessionSource } from './use-remote-session-source';
import { deferred, hosts, session } from './use-remote-session-source-test-fixture';

function withRemoteState(
  status: RemoteHostConnectionStatus,
  options: { capabilities?: string[]; recovery?: 'worker-offline' | null } = {},
): RemoteHostSnapshotState {
  const current = hosts('remote-a', 1);
  return {
    ...current,
    snapshot: {
      ...current.snapshot!,
      states: current.snapshot!.states.map((state) => state.profileId === 'remote-a'
        ? {
            ...state,
            status,
            recovery: options.recovery ?? null,
            ...(options.capabilities ? { capabilities: options.capabilities } : {}),
          }
        : state),
    },
  };
}

function withWorkerGeneration(generation: number): RemoteHostSnapshotState {
  const current = hosts('remote-a', generation);
  return {
    ...current,
    snapshot: {
      ...current.snapshot!,
      states: current.snapshot!.states.map((state) => state.profileId === 'remote-a'
        ? {
            ...state,
            authoritativeCoreId: 'core-stable',
            workerGeneration: generation,
          }
        : state),
    },
  };
}

function sessionPage(title: string, revision: number): RemoteHostSessionPageDto {
  return {
    sessions: [session('same-session', title)],
    nextCursor: null,
    total: 1,
    revision,
  };
}

describe('useRemoteSessionSource source fencing', () => {
  const oldDetail = deferred<ReturnType<typeof session>>();

  beforeEach(() => {
    window.api = {
      listRemoteHostSessions: vi.fn(async (request) => ({
        sessions: request.includeArchived ? [] : [{
          id: 'same-session',
          adapterId: 'codex-cli',
          title: `${request.profileId} list`,
          status: 'active-idle',
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
      listRemoteHostPendingIndex: vi.fn(async (request) => {
        const revision = request.profileId === 'remote-a' ? 10 : 20;
        return {
          buckets: [{
            session: legacyRemoteSessionPresentation(session(
              'same-session',
              `${request.profileId} list`,
            )),
            pending: {
              requests: [{
                id: 'same-request', sessionId: 'same-session', kind: 'permission',
                status: 'pending', createdAt: 1, expiresAt: null,
                display: { source: request.profileId },
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
        resourceRevisionsByProfile: new Map([
          ['remote-a', hosts('remote-a', 1).resourceRevisionsByProfile.get('remote-a')!],
          ['remote-b', hosts('remote-b', 99).resourceRevisionsByProfile.get('remote-b')!],
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
      status: 'active-idle',
      createdAt: 1,
      updatedAt: 4,
    });
    await act(async () => { await oldDetail.promise; });
    expect(hook.result.current.selectedSession?.title).toBe('remote-b detail');
  });

  it.each([
    ['connecting', null],
    ['reconnecting', null],
    ['offline', null],
    ['offline', 'worker-offline'],
    ['incompatible', null],
  ] as const)('admits no session reads while the Remote source is %s/%s', async (
    status,
    recovery,
  ) => {
    const hook = renderHook(() => useRemoteSessionSource(withRemoteState(status, { recovery })));
    await act(async () => { await Promise.resolve(); });

    expect(hook.result.current.usable).toBe(false);
    expect(hook.result.current.sessions).toEqual([]);
    expect(hook.result.current.historySessions).toEqual([]);
    expect(hook.result.current.sessionTotal).toBeNull();
    expect(window.api.listRemoteHostSessions).not.toHaveBeenCalled();
  });

  it('retires retained Remote readers while snapshot authority is unknown and resumes after recovery', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));

    const retained = hosts('remote-a', 2);
    hook.rerender({
      value: {
        ...retained,
        snapshotError: '无法确认 Remote 数据源。',
        error: '无法确认 Remote 数据源。',
      },
    });

    expect(hook.result.current.usable).toBe(false);
    expect(hook.result.current.sessions).toEqual([]);
    expect(hook.result.current.historySessions).toEqual([]);
    expect(hook.result.current.pendingTotal).toBeNull();
    vi.mocked(window.api.listRemoteHostSessions).mockClear();
    vi.mocked(window.api.listRemoteHostPendingIndex).mockClear();

    hook.rerender({
      value: {
        ...hosts('remote-a', 3),
        snapshot: retained.snapshot,
        snapshotError: '无法确认 Remote 数据源。',
        error: '无法确认 Remote 数据源。',
      },
    });
    await act(async () => { await Promise.resolve(); });
    expect(window.api.listRemoteHostSessions).not.toHaveBeenCalled();
    expect(window.api.listRemoteHostPendingIndex).not.toHaveBeenCalled();

    hook.rerender({ value: hosts('remote-a', 3) });
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    expect(window.api.listRemoteHostSessions).toHaveBeenCalled();
    expect(window.api.listRemoteHostPendingIndex).toHaveBeenCalled();
  });

  it('clears visible data immediately and rejects a stale action after reconnect starts', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    const staleCapabilitiesRead = hook.result.current.getSessionCapabilities;
    const listCalls = vi.mocked(window.api.listRemoteHostSessions).mock.calls.length;

    hook.rerender({ value: withRemoteState('reconnecting') });
    expect(hook.result.current.usable).toBe(false);
    expect(hook.result.current.sessions).toEqual([]);
    expect(hook.result.current.historySessions).toEqual([]);
    expect(hook.result.current.sessionTotal).toBeNull();
    await expect(staleCapabilitiesRead({
      adapterId: 'codex-cli',
      provider: '',
      workingDirectory: '.',
    })).rejects.toThrow('尚未连接');
    expect(window.api.getRemoteHostSessionCapabilities).not.toHaveBeenCalled();
    expect(window.api.listRemoteHostSessions).toHaveBeenCalledTimes(listCalls);
  });

  it('does not request a list surface whose capability is absent', async () => {
    const noBase = renderHook(() => useRemoteSessionSource(withRemoteState('connected', {
      capabilities: [],
    })));
    await act(async () => { await Promise.resolve(); });
    expect(noBase.result.current.usable).toBe(true);
    expect(window.api.listRemoteHostSessions).not.toHaveBeenCalled();
    noBase.unmount();

    vi.mocked(window.api.listRemoteHostSessions).mockClear();
    const liveOnly = renderHook(() => useRemoteSessionSource(withRemoteState('connected', {
      capabilities: ['session-console.read'],
    })));
    await waitFor(() => expect(liveOnly.result.current.sessions).toHaveLength(1));
    expect(window.api.listRemoteHostSessions).toHaveBeenCalledOnce();
    expect(window.api.listRemoteHostSessions).toHaveBeenCalledWith(expect.objectContaining({
      includeArchived: false,
    }));
    expect(liveOnly.result.current.historySessions).toEqual([]);
  });

  it('selects the canonical session when create returns an already-renamed temporary id', async () => {
    vi.mocked(window.api.getRemoteHostSession).mockResolvedValue({
      id: 'canonical-a', adapterId: 'codex-cli', title: 'Canonical detail',
      status: 'active-idle', createdAt: 1, updatedAt: 3,
    });
    const current = hosts('remote-a', 1);
    const identity = remoteSourceIdentity('remote-a', 'core-remote-a', null);
    const hook = renderHook(() => useRemoteSessionSource({
      ...current,
      sessionRenamesBySource: new Map([
        [identity, new Map([['temporary-a', 'canonical-a']])],
      ]),
    }));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));

    act(() => hook.result.current.selectSession('temporary-a'));

    expect(hook.result.current.selectedSessionId).toBe('canonical-a');
    await waitFor(() => expect(window.api.getRemoteHostSession).toHaveBeenCalledWith({
      profileId: 'remote-a', sessionId: 'canonical-a',
    }));
    await waitFor(() => expect(hook.result.current.selectedSession?.id).toBe('canonical-a'));
  });

  it('moves an already-selected temporary session to a later canonical rename', async () => {
    const temporaryDetail = deferred<ReturnType<typeof session>>();
    vi.mocked(window.api.getRemoteHostSession).mockImplementation((request) =>
      request.sessionId === 'temporary-a'
        ? temporaryDetail.promise
        : Promise.resolve(session('canonical-a', 'Canonical detail')));
    const current = hosts('remote-a', 1);
    const identity = remoteSourceIdentity('remote-a', 'core-remote-a', null);
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: current } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('temporary-a'));
    await waitFor(() => expect(window.api.getRemoteHostSession).toHaveBeenCalledWith({
      profileId: 'remote-a', sessionId: 'temporary-a',
    }));

    hook.rerender({
      value: {
        ...current,
        sessionRenamesBySource: new Map([
          [identity, new Map([['temporary-a', 'canonical-a']])],
        ]),
      },
    });

    await waitFor(() => expect(hook.result.current.selectedSessionId).toBe('canonical-a'));
    await waitFor(() => expect(hook.result.current.selectedSession?.id).toBe('canonical-a'));
    temporaryDetail.resolve(session('temporary-a', 'Late temporary detail'));
    await act(async () => { await temporaryDetail.promise; });
    expect(hook.result.current.selectedSession?.id).toBe('canonical-a');
  });

  it('rejects a Workspace directory result after the source identity changes', async () => {
    const listing = deferred<{
      directory: string;
      directories: [];
      truncated: boolean;
      revision: number;
    }>();
    vi.mocked(window.api.listRemoteHostWorkspaceDirectories).mockReturnValue(listing.promise);
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-a list'));
    const pending = hook.result.current.listWorkspaceDirectories('.');
    await waitFor(() => expect(window.api.listRemoteHostWorkspaceDirectories).toHaveBeenCalledWith({
      profileId: 'remote-a', directory: '.',
    }));

    hook.rerender({ value: hosts('remote-b', 2) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    listing.resolve({ directory: '.', directories: [], truncated: false, revision: 1 });

    await expect(pending).rejects.toThrow('数据源已切换');
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
          status: 'active-idle',
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
        status: 'active-idle',
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

  it('starts a fresh list after same-identity reconnect and drops the old in-flight page', async () => {
    const oldPage = deferred<RemoteHostSessionPageDto>();
    let liveCalls = 0;
    vi.mocked(window.api.listRemoteHostSessions).mockImplementation((request) => {
      if (request.includeArchived) {
        return Promise.resolve({ sessions: [], nextCursor: null, total: 0, revision: 1 });
      }
      liveCalls += 1;
      return liveCalls === 1
        ? oldPage.promise
        : Promise.resolve(sessionPage('fresh reconnect', 2));
    });
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: hosts('remote-a', 1) } },
    );
    await waitFor(() => expect(liveCalls).toBe(1));

    hook.rerender({ value: withRemoteState('reconnecting') });
    expect(hook.result.current.sessions).toEqual([]);
    hook.rerender({ value: hosts('remote-a', 1) });
    await waitFor(() => expect(liveCalls).toBe(2));
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('fresh reconnect'));

    oldPage.resolve(sessionPage('stale pre-reconnect', 1));
    await act(async () => { await oldPage.promise; });
    expect(hook.result.current.sessions[0]?.title).toBe('fresh reconnect');
  });

  it('keeps only the newest page across rapid Worker generation changes', async () => {
    const first = deferred<RemoteHostSessionPageDto>();
    const second = deferred<RemoteHostSessionPageDto>();
    const third = deferred<RemoteHostSessionPageDto>();
    const pages = [first, second, third];
    let liveCalls = 0;
    vi.mocked(window.api.listRemoteHostSessions).mockImplementation((request) => {
      if (request.includeArchived) {
        return Promise.resolve({ sessions: [], nextCursor: null, total: 0, revision: 1 });
      }
      return pages[liveCalls++]!.promise;
    });
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: withWorkerGeneration(1) } },
    );
    await waitFor(() => expect(liveCalls).toBe(1));
    hook.rerender({ value: withWorkerGeneration(2) });
    await waitFor(() => expect(liveCalls).toBe(2));
    hook.rerender({ value: withWorkerGeneration(3) });
    await waitFor(() => expect(liveCalls).toBe(3));

    third.resolve(sessionPage('generation 3', 3));
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('generation 3'));
    second.resolve(sessionPage('stale generation 2', 2));
    first.resolve(sessionPage('stale generation 1', 1));
    await act(async () => { await Promise.all([first.promise, second.promise]); });
    expect(hook.result.current.sessions[0]?.title).toBe('generation 3');
  });
});
