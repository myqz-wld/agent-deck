// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteHostPendingIndexDto,
  RemoteHostResourceKind,
  RemoteHostResourceRevisions,
  RemoteHostSessionPresentationDto,
  RemoteHostSessionPresentationPageDto,
} from '@shared/remote-host';
import { REMOTE_HOST_RESOURCE_KINDS } from '@shared/remote-host';
import { useRemotePresentationLists } from './use-remote-presentation-lists';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function revisions(
  kind?: RemoteHostResourceKind,
  revision = 0,
): RemoteHostResourceRevisions {
  return Object.fromEntries(REMOTE_HOST_RESOURCE_KINDS.map((item) => [
    item, item === kind ? revision : 0,
  ])) as RemoteHostResourceRevisions;
}

function session(id = 'session-a'): RemoteHostSessionPresentationDto {
  return {
    id, adapterId: 'codex-cli', title: id, source: 'sdk', lifecycle: 'active',
    activity: 'waiting', archived: false, pinned: false, createdAt: 1, updatedAt: 2,
    endedAt: null, model: null, thinking: null, runtimeProvider: null, context: null,
    spawnedBy: null, spawnDepth: 0, teams: [], summary: null,
    workspaceLabel: 'Workspace', contextOnly: false,
  };
}

function page(
  kind: 'history' | 'live',
  revision = 1,
  rows = kind === 'live' ? [session()] : [],
  nextCursor: string | null = null,
): RemoteHostSessionPresentationPageDto {
  return {
    sessions: rows,
    nextCursor,
    counts: {
      total: rows.length,
      active: kind === 'live' ? rows.length : 0,
      dormant: 0,
      closed: kind === 'history' ? rows.length : 0,
      working: 0,
      waiting: kind === 'live' ? rows.length : 0,
    },
    contextTruncated: false,
    revision,
  };
}

function pending(
  revision = 1,
  id = 'session-a',
  nextCursor: string | null = null,
): RemoteHostPendingIndexDto {
  return {
    buckets: [{
      session: session(id),
      pending: {
        requests: [{
          id: `request-${id}`, sessionId: id, kind: 'permission', status: 'pending',
          createdAt: 1, expiresAt: null, display: {},
        }],
        revision,
      },
    }],
    nextCursor,
    totalBuckets: 1,
    totalRequests: 1,
    scanTruncated: false,
    revision,
  };
}

const capabilities = new Set([
  'sessions.presentation.read', 'pending.index.read', 'sessions.history',
  'sessions.history.write',
]);

function renderLists(resourceRevisions = revisions()) {
  return renderHook(({ resources }) => useRemotePresentationLists({
    activeProfileId: 'remote-a', capabilities, identity: 'remote-a:core-a:1',
    localRevision: 0, resourceRevisions: resources, usable: true,
  }), { initialProps: { resources: resourceRevisions } });
}

describe('useRemotePresentationLists', () => {
  it('requests an archived-only history page only after the explicit filter changes', async () => {
    const list = vi.fn((request: { kind: 'history' | 'live'; archivedOnly?: boolean }) =>
      Promise.resolve(page(request.kind)));
    window.api = {
      listRemoteHostSessionPresentations: list,
      listRemoteHostPendingIndex: vi.fn(async () => pending()),
    } as unknown as typeof window.api;
    const hook = renderLists();
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'history',
    })));
    expect(list.mock.calls.some(([request]) => request.archivedOnly === true)).toBe(false);

    act(() => hook.result.current.setHistoryArchivedOnly(true));
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'history', archivedOnly: true,
    })));
    expect(hook.result.current.historyArchivedOnly).toBe(true);
  });

  it('coalesces a session-list burst without refreshing Pending', async () => {
    const live = deferred<RemoteHostSessionPresentationPageDto>();
    const history = deferred<RemoteHostSessionPresentationPageDto>();
    const listPresentations = vi.fn((request: { kind: 'history' | 'live' }) => {
      if (listPresentations.mock.calls.length <= 2) {
        return request.kind === 'live' ? live.promise : history.promise;
      }
      return Promise.resolve(page(request.kind, 2));
    });
    const listPending = vi.fn(async () => pending());
    window.api = {
      listRemoteHostSessionPresentations: listPresentations,
      listRemoteHostPendingIndex: listPending,
    } as unknown as typeof window.api;
    const { rerender } = renderLists();
    await waitFor(() => expect(listPresentations).toHaveBeenCalledTimes(2));
    rerender({ resources: revisions('session-list', 1) });
    rerender({ resources: revisions('session-list', 2) });
    expect(listPresentations).toHaveBeenCalledTimes(2);
    await act(async () => {
      live.resolve(page('live'));
      history.resolve(page('history'));
      await Promise.resolve();
    });
    await waitFor(() => expect(listPresentations).toHaveBeenCalledTimes(4));
    expect(listPending).toHaveBeenCalledOnce();
  });

  it('refreshes only Pending for a pending resource revision', async () => {
    window.api = {
      listRemoteHostSessionPresentations: vi.fn((request) => Promise.resolve(page(request.kind))),
      listRemoteHostPendingIndex: vi.fn(async () => pending()),
    } as unknown as typeof window.api;
    const hook = renderLists();
    await waitFor(() => expect(window.api.listRemoteHostPendingIndex).toHaveBeenCalledOnce());
    const presentationCalls = vi.mocked(window.api.listRemoteHostSessionPresentations).mock.calls.length;
    hook.rerender({ resources: revisions('pending', 4) });
    await waitFor(() => expect(window.api.listRemoteHostPendingIndex).toHaveBeenCalledTimes(2));
    expect(window.api.listRemoteHostSessionPresentations).toHaveBeenCalledTimes(presentationCalls);
  });

  it('does not let an older Pending result overwrite a newer detail refresh', async () => {
    window.api = {
      listRemoteHostSessionPresentations: vi.fn((request) => Promise.resolve(page(request.kind))),
      listRemoteHostPendingIndex: vi.fn(async () => pending(5)),
    } as unknown as typeof window.api;
    const hook = renderLists();
    await waitFor(() => expect(hook.result.current.pendingBuckets).toHaveLength(1));
    act(() => hook.result.current.mergePending('session-a', { requests: [], revision: 10 }));
    hook.rerender({ resources: revisions('pending', 1) });
    await waitFor(() => expect(window.api.listRemoteHostPendingIndex).toHaveBeenCalledTimes(2));
    expect(hook.result.current.pendingBuckets[0]?.pending.revision).toBe(10);
    expect(hook.result.current.pendingBySession.get('session-a')?.revision).toBe(10);
  });

  it('retires a late Live page when its base resource revision changes', async () => {
    const latePage = deferred<RemoteHostSessionPresentationPageDto>();
    const list = vi.fn((request: { kind: 'history' | 'live'; cursor?: string }) => {
      if (request.kind === 'history') return Promise.resolve(page('history'));
      if (request.cursor) return latePage.promise;
      return Promise.resolve(list.mock.calls.filter(([call]) => call.kind === 'live').length === 1
        ? page('live', 1, [session('base-live')], 'next-live')
        : page('live', 2, [session('fresh-live')]));
    });
    window.api = {
      listRemoteHostSessionPresentations: list,
      listRemoteHostPendingIndex: vi.fn(async () => pending()),
    } as unknown as typeof window.api;
    const hook = renderLists();
    await waitFor(() => expect(hook.result.current.hasMoreSessions).toBe(true));
    let loadMore!: Promise<void>;
    act(() => { loadMore = hook.result.current.loadMoreSessions(); });
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'live', cursor: 'next-live',
    })));
    hook.rerender({ resources: revisions('session-list', 2) });
    await waitFor(() => expect(hook.result.current.sessions[0]?.id).toBe('fresh-live'));
    await act(async () => {
      latePage.resolve(page('live', 1, [session('stale-live')]));
      await loadMore;
    });
    expect(hook.result.current.sessions.map((row) => row.id)).toEqual(['fresh-live']);
  });

  it('retires a late History page when the query changes', async () => {
    const latePage = deferred<RemoteHostSessionPresentationPageDto>();
    const list = vi.fn((request: { kind: 'history' | 'live'; cursor?: string; query?: string }) => {
      if (request.kind === 'live') return Promise.resolve(page('live'));
      if (request.cursor) return latePage.promise;
      return Promise.resolve(request.query
        ? page('history', 2, [session('query-result')])
        : page('history', 1, [session('base-history')], 'next-history'));
    });
    window.api = {
      listRemoteHostSessionPresentations: list,
      listRemoteHostPendingIndex: vi.fn(async () => pending()),
    } as unknown as typeof window.api;
    const hook = renderLists();
    await waitFor(() => expect(hook.result.current.hasMoreHistorySessions).toBe(true));
    let loadMore!: Promise<void>;
    act(() => { loadMore = hook.result.current.loadMoreHistorySessions(); });
    act(() => hook.result.current.setHistoryQuery('needle'));
    await waitFor(() => expect(hook.result.current.historySessions[0]?.id).toBe('query-result'));
    await act(async () => {
      latePage.resolve(page('history', 1, [session('stale-history')]));
      await loadMore;
    });
    expect(hook.result.current.historySessions.map((row) => row.id)).toEqual(['query-result']);
  });

  it('retires a late Pending page when its base revision changes', async () => {
    const latePage = deferred<RemoteHostPendingIndexDto>();
    const listPending = vi.fn((request: { cursor?: string }) => request.cursor
      ? latePage.promise
      : Promise.resolve(listPending.mock.calls.length === 1
          ? pending(1, 'base-pending', 'next-pending')
          : pending(2, 'fresh-pending')));
    window.api = {
      listRemoteHostSessionPresentations: vi.fn((request) => Promise.resolve(page(request.kind))),
      listRemoteHostPendingIndex: listPending,
    } as unknown as typeof window.api;
    const hook = renderLists();
    await waitFor(() => expect(hook.result.current.hasMorePending).toBe(true));
    let loadMore!: Promise<void>;
    act(() => { loadMore = hook.result.current.loadMorePending(); });
    hook.rerender({ resources: revisions('pending', 2) });
    await waitFor(() => expect(hook.result.current.pendingBuckets[0]?.session.id)
      .toBe('fresh-pending'));
    await act(async () => {
      latePage.resolve(pending(1, 'stale-pending'));
      await loadMore;
    });
    expect(hook.result.current.pendingBuckets.map((bucket) => bucket.session.id))
      .toEqual(['fresh-pending']);
  });
});
