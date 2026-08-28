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

describe('useRemoteSessionSource source fencing', () => {
  const oldDetail = deferred<ReturnType<typeof session>>();

  beforeEach(() => {
    window.api = {
      listRemoteHostSessionPresentations: vi.fn(async (request) =>
        sessionPage(`${request.profileId} list`, 1, request.kind)),
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

  it('isolates identical session and pending ids and drops the old source response', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-a list'));
    expect(hook.result.current.pendingBySession.get('same-session')).toMatchObject({
      revision: 10,
      requests: [{ display: { input: { source: 'remote-a' } } }],
    });
    const listCallsBeforeUnrelatedEvent = vi.mocked(
      window.api.listRemoteHostSessionPresentations,
    ).mock.calls.length;
    hook.rerender({
      value: {
        ...currentHosts('remote-a', 1),
        dataRevisionByProfile: new Map([
          ['remote-a', 1],
          ['remote-b', 99],
        ]),
        resourceRevisionsByProfile: new Map([
          ['remote-a', currentHosts('remote-a', 1).resourceRevisionsByProfile.get('remote-a')!],
          ['remote-b', currentHosts('remote-b', 99).resourceRevisionsByProfile.get('remote-b')!],
        ]),
      },
    });
    await act(async () => { await Promise.resolve(); });
    expect(window.api.listRemoteHostSessionPresentations).toHaveBeenCalledTimes(
      listCallsBeforeUnrelatedEvent,
    );

    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(window.api.getRemoteHostSession).toHaveBeenCalledWith({
      profileId: 'remote-a', sessionId: 'same-session',
    }));

    hook.rerender({ value: currentHosts('remote-b', 2) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.title).toBe('remote-b list'));
    expect(hook.result.current.selectedSessionId).toBeNull();
    expect(window.api.getRemoteHostSession).toHaveBeenCalledTimes(1);
    expect(hook.result.current.pendingBySession.get('same-session')).toMatchObject({
      revision: 20,
      requests: [{ display: { input: { source: 'remote-b' } } }],
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
    expect(window.api.listRemoteHostSessionPresentations).not.toHaveBeenCalled();
  });

  it('retires retained Remote readers while snapshot authority is unknown and resumes after recovery', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));

    const retained = currentHosts('remote-a', 2);
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
    vi.mocked(window.api.listRemoteHostSessionPresentations).mockClear();
    vi.mocked(window.api.listRemoteHostPendingIndex).mockClear();

    hook.rerender({
      value: {
        ...currentHosts('remote-a', 3),
        snapshot: retained.snapshot,
        snapshotError: '无法确认 Remote 数据源。',
        error: '无法确认 Remote 数据源。',
      },
    });
    await act(async () => { await Promise.resolve(); });
    expect(window.api.listRemoteHostSessionPresentations).not.toHaveBeenCalled();
    expect(window.api.listRemoteHostPendingIndex).not.toHaveBeenCalled();

    hook.rerender({ value: currentHosts('remote-a', 3) });
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    expect(window.api.listRemoteHostSessionPresentations).toHaveBeenCalled();
    expect(window.api.listRemoteHostPendingIndex).toHaveBeenCalled();
  });

  it('clears visible data immediately and rejects a stale action after reconnect starts', async () => {
    const hook = renderHook(
      ({ value }: { value: RemoteHostSnapshotState }) => useRemoteSessionSource(value),
      { initialProps: { value: currentHosts('remote-a', 1) } },
    );
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    const staleCapabilitiesRead = hook.result.current.getSessionCapabilities;
    const listCalls = vi.mocked(window.api.listRemoteHostSessionPresentations).mock.calls.length;

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
    expect(window.api.listRemoteHostSessionPresentations).toHaveBeenCalledTimes(listCalls);
  });

  it('does not request a list surface whose capability is absent', async () => {
    const noBase = renderHook(() => useRemoteSessionSource(withRemoteState('connected', {
      capabilities: [],
    })));
    await act(async () => { await Promise.resolve(); });
    expect(noBase.result.current.usable).toBe(true);
    expect(window.api.listRemoteHostSessionPresentations).not.toHaveBeenCalled();
    noBase.unmount();

    vi.mocked(window.api.listRemoteHostSessionPresentations).mockClear();
    const richOnly = renderHook(() => useRemoteSessionSource(withRemoteState('connected', {
      capabilities: ['sessions.presentation.read'],
    })));
    await waitFor(() => expect(richOnly.result.current.sessions).toHaveLength(1));
    expect(window.api.listRemoteHostSessionPresentations).toHaveBeenCalledTimes(2);
    expect(window.api.listRemoteHostSessionPresentations).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'live',
    }));
    expect(richOnly.result.current.historySessions).toEqual([]);
  });

  it('selects the canonical session when create returns an already-renamed temporary id', async () => {
    vi.mocked(window.api.getRemoteHostSession).mockResolvedValue({
      id: 'canonical-a', adapterId: 'codex-cli', title: 'Canonical detail',
      status: 'active-idle', createdAt: 1, updatedAt: 3,
    });
    const current = currentHosts('remote-a', 1);
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

});
