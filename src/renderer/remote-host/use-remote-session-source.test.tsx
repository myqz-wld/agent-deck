// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import { remotePendingPresentation } from './remote-pending-presentation';
import { useRemoteSessionSource } from './use-remote-session-source';
import { deferred, hosts, session } from './use-remote-session-source-test-fixture';

describe('useRemoteSessionSource source fencing', () => {
  const oldDetail = deferred<ReturnType<typeof session>>();

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
    const hook = renderHook(() => useRemoteSessionSource(hosts('remote-a', 1)));
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
      expectedPresentationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
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

  it('loads event/summary/task state and fences on-demand file reads to the current source', async () => {
    const currentHosts = hosts('remote-b', 1);
    currentHosts.snapshot!.states = currentHosts.snapshot!.states.map((current) =>
      current.profileId === 'remote-b'
        ? {
            ...current,
            capabilities: [
              ...current.capabilities,
              'sessions.summaries.read',
              'sessions.file-changes.read',
              'assets',
              'tasks',
            ],
          }
        : current);
    vi.mocked(window.api.listRemoteHostSummaries).mockResolvedValue({
      summaries: [{
        id: 1,
        sessionId: 'same-session',
        content: 'remote summary',
        trigger: 'time',
        ts: 2,
        sourceEventRevision: 1,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }],
      revision: 2,
    });
    vi.mocked(window.api.listRemoteHostTasks).mockResolvedValue({
      tasks: [{
        id: 'task-1', ownerSessionId: 'same-session', teamId: null,
        subject: 'remote task', description: null, status: 'active', activeForm: null,
        priority: 5, blocks: [], blockedBy: [], labels: [],
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:01:00.000Z',
      }],
      revision: 2,
    });
    vi.mocked(window.api.listRemoteHostEvents).mockResolvedValue({
      events: [{
        id: 7, sessionId: 'same-session', agentId: 'codex-cli', kind: 'message',
        payload: { role: 'assistant', text: 'remote event' }, ts: 2,
      }],
      revision: 2,
      truncated: false,
    });
    const hook = renderHook(() => useRemoteSessionSource(currentHosts));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));
    await waitFor(() => expect(hook.result.current.summaries?.summaries[0]?.content)
      .toBe('remote summary'));
    await waitFor(() => expect(hook.result.current.tasks?.tasks[0]?.subject).toBe('remote task'));
    await waitFor(() => expect(hook.result.current.events?.events[0]?.id).toBe(7));
    expect(window.api.listRemoteHostEvents).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', limit: 100,
    });

    await act(async () => { await hook.result.current.listFileChanges(); });
    await act(async () => { await hook.result.current.getFileChange(3); });
    await act(async () => { await hook.result.current.getFileFinalDiff('repo/src/index.ts'); });
    await act(async () => {
      await hook.result.current.loadImageBlob('same-session', {
        kind: 'remote-file-change', changeId: 3, side: 'after',
      });
    });
    expect(window.api.listRemoteHostFileChanges).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', limit: 40,
    });
    expect(window.api.getRemoteHostFileChange).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', changeId: 3,
    });
    expect(window.api.getRemoteHostFileFinalDiff).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session', filePath: 'repo/src/index.ts',
    });
    expect(window.api.loadRemoteHostImageAsset).toHaveBeenCalledWith({
      profileId: 'remote-b', sessionId: 'same-session',
      source: { kind: 'remote-file-change', changeId: 3, side: 'after' },
    });
  });

  it('publishes the required session when an optional summary read fails', async () => {
    const currentHosts = hosts('remote-b', 1);
    currentHosts.snapshot!.states = currentHosts.snapshot!.states.map((current) =>
      current.profileId === 'remote-b'
        ? { ...current, capabilities: [...current.capabilities, 'sessions.summaries.read'] }
        : current);
    vi.mocked(window.api.listRemoteHostSummaries).mockRejectedValue(
      new Error('summary unavailable'),
    );
    const hook = renderHook(() => useRemoteSessionSource(currentHosts));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(1));
    act(() => hook.result.current.selectSession('same-session'));

    await waitFor(() => expect(hook.result.current.selectedSession?.title)
      .toBe('remote-b detail'));
    expect(hook.result.current.summaries).toBeNull();
    expect(hook.result.current.summaryLoadError).toBe('summary unavailable');
  });
});
