// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPermissionPreviewDisplay } from '@contracts/index';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import type {
  RemoteHostConnectionStatus,
  RemoteHostSessionPresentationDto,
  RemoteHostSessionPresentationPageDto,
} from '@shared/remote-host';
import { remoteSourceIdentity } from './remote-source-utils';
import { useRemoteSessionSource } from './use-remote-session-source';
import {
  deferred,
  hosts as fixtureHosts,
  session,
} from './use-remote-session-source-test-fixture';

function presentation(id: string, title: string): RemoteHostSessionPresentationDto {
  return {
    id, adapterId: 'codex-cli', title, source: 'sdk', lifecycle: 'active', activity: 'idle',
    archived: false, pinned: false, createdAt: 1, updatedAt: 2, endedAt: null,
    model: null, thinking: null, runtimeProvider: null, context: null, spawnedBy: null,
    spawnDepth: 0, teams: [], summary: null, summaryGenerationSource: null,
    workspaceLabel: null, contextOnly: false,
  };
}

function sessionPage(
  title: string,
  revision: number,
  kind: 'history' | 'live' = 'live',
): RemoteHostSessionPresentationPageDto {
  const sessions = kind === 'live' ? [presentation('same-session', title)] : [];
  return {
    sessions,
    nextCursor: null,
    counts: {
      total: sessions.length,
      active: sessions.length,
      dormant: 0,
      closed: 0,
      working: 0,
      waiting: 0,
    },
    contextTruncated: false,
    revision,
  };
}

function currentHosts(profileId: string | null, dataRevision: number): RemoteHostSnapshotState {
  const current = fixtureHosts(profileId, dataRevision);
  if (!profileId || !current.snapshot) return current;
  return {
    ...current,
    snapshot: {
      ...current.snapshot,
      states: current.snapshot.states.map((state) => state.profileId === profileId
        ? {
            ...state,
            capabilities: [...new Set([
              ...state.capabilities,
              'sessions.input.read',
              'sessions.presentation.read',
            ])],
          }
        : state),
    },
  };
}

function withRemoteState(
  status: RemoteHostConnectionStatus,
  options: { capabilities?: string[]; recovery?: 'worker-offline' | null } = {},
): RemoteHostSnapshotState {
  const current = currentHosts('remote-a', 1);
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
  const current = currentHosts('remote-a', generation);
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

describe('useRemoteSessionSource refresh fencing', () => {
  const oldDetail = deferred<ReturnType<typeof session>>();

  beforeEach(() => {
    window.api = {
      listRemoteHostSessionPresentations: vi.fn(async (request) =>
        sessionPage(`${request.profileId} list`, 1, request.kind)),
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
            session: presentation('same-session', `${request.profileId} list`),
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

  it('moves an already-selected temporary session to a later canonical rename', async () => {
    const temporaryDetail = deferred<ReturnType<typeof session>>();
    vi.mocked(window.api.getRemoteHostSession).mockImplementation((request) =>
      request.sessionId === 'temporary-a'
        ? temporaryDetail.promise
        : Promise.resolve(session('canonical-a', 'Canonical detail')));
    const current = currentHosts('remote-a', 1);
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
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-a list'));
    const pending = hook.result.current.listWorkspaceDirectories('.');
    await waitFor(() => expect(window.api.listRemoteHostWorkspaceDirectories).toHaveBeenCalledWith({
      profileId: 'remote-a', directory: '.',
    }));

    hook.rerender({ value: currentHosts('remote-b', 2) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    listing.resolve({ directory: '.', directories: [], truncated: false, revision: 1 });

    await expect(pending).rejects.toThrow('数据源已切换');
  });

  it('keeps at most one list refresh in flight and merges later invalidations', async () => {
    const firstPage = deferred<RemoteHostSessionPresentationPageDto>();
    let liveCalls = 0;
    vi.mocked(window.api.listRemoteHostSessionPresentations).mockImplementation((request) => {
      if (request.kind === 'history') return Promise.resolve(sessionPage('', 1, 'history'));
      if (liveCalls++ === 0) return firstPage.promise;
      return Promise.resolve(sessionPage('refreshed', 2));
    });
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(liveCalls).toBe(1));

    hook.rerender({ value: currentHosts('remote-a', 2) });
    hook.rerender({ value: currentHosts('remote-a', 3) });
    await act(async () => { await Promise.resolve(); });
    expect(liveCalls).toBe(1);

    firstPage.resolve(sessionPage('initial', 1));
    await waitFor(() => expect(liveCalls).toBe(2));
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('refreshed'));
    expect(liveCalls).toBe(2);
  });

  it('starts a fresh list after same-identity reconnect and drops the old in-flight page', async () => {
    const oldPage = deferred<RemoteHostSessionPresentationPageDto>();
    let liveCalls = 0;
    vi.mocked(window.api.listRemoteHostSessionPresentations).mockImplementation((request) => {
      if (request.kind === 'history') return Promise.resolve(sessionPage('', 1, 'history'));
      liveCalls += 1;
      return liveCalls === 1
        ? oldPage.promise
        : Promise.resolve(sessionPage('fresh reconnect', 2));
    });
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(liveCalls).toBe(1));

    hook.rerender({ value: withRemoteState('reconnecting') });
    expect(hook.result.current.sessions).toEqual([]);
    hook.rerender({ value: currentHosts('remote-a', 1) });
    await waitFor(() => expect(liveCalls).toBe(2));
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('fresh reconnect'));

    oldPage.resolve(sessionPage('stale pre-reconnect', 1));
    await act(async () => { await oldPage.promise; });
    expect(hook.result.current.sessions[0]?.title).toBe('fresh reconnect');
  });

  it('keeps only the newest page across rapid Worker generation changes', async () => {
    const first = deferred<RemoteHostSessionPresentationPageDto>();
    const second = deferred<RemoteHostSessionPresentationPageDto>();
    const third = deferred<RemoteHostSessionPresentationPageDto>();
    const pages = [first, second, third];
    let liveCalls = 0;
    vi.mocked(window.api.listRemoteHostSessionPresentations).mockImplementation((request) => {
      if (request.kind === 'history') return Promise.resolve(sessionPage('', 1, 'history'));
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
