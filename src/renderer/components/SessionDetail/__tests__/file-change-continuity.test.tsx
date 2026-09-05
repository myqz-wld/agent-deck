// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, FileChangePage, FileChangeSummary } from '@shared/types';
import { useFileChanges } from '../use-file-changes';
import { useFileChangeSelection } from '../use-file-change-selection';
import { useFileChangePages } from '../use-file-change-pages';

const summary = (id: number): FileChangeSummary => ({
  id, sessionId: 's1', filePath: 'repo/repeated.ts', kind: 'text', toolCallId: null, ts: id,
  hasBeforeBlob: false, hasAfterBlob: false, hasBeforeSnapshot: false, hasAfterSnapshot: false,
});
const records = (count: number) => Array.from({ length: count }, (_, i) => summary(count - i));
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve!: (page: FileChangePage) => void;
  const promise = new Promise<FileChangePage>((done) => { resolve = done; });
  return { resolve, promise };
};
function localApi(initial: number) {
  let rows = records(initial);
  const listeners = new Set<(event: AgentEvent) => void>();
  const list = vi.fn(async (_sessionId: string, options: { cursor?: string; limit: number }) => {
    const remaining = options.cursor ? rows.filter((row) => row.id < Number(options.cursor)) : rows;
    const items = remaining.slice(0, options.limit);
    return { items, nextCursor: remaining.length > items.length ? String(items.at(-1)!.id) : null };
  });
  window.api = {
    listFileChangePage: list,
    onAgentEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as unknown as typeof window.api;
  return {
    list, listeners,
    replace: (count: number) => { rows = records(count); },
    burst: (count: number) => {
      for (let id = 0; id < count; id++) for (const listener of listeners) {
        listener({ sessionId: 's1', agentId: 'codex-cli', kind: 'file-changed', payload: {}, ts: id });
      }
    },
  };
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('revalidates Local activation and preserves a deliberate historical selection', async () => {
  const api = localApi(2);
  const hook = renderHook(({ enabled }) => {
    const pages = useFileChanges({ sessionId: 's1', enabled });
    const selection = useFileChangeSelection({ sessionId: 's1', workspaceKey: 'repo', changes: pages.changes });
    return { pages, selection };
  }, { initialProps: { enabled: true } });
  await act(flush);
  act(() => hook.result.current.selection.selectChange(1));
  hook.rerender({ enabled: false });
  expect(api.listeners.size).toBe(0);
  api.replace(3);
  hook.rerender({ enabled: true });
  await act(flush);
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(hook.result.current.pages.changes?.map((row) => row.id)).toEqual([3, 2, 1]);
  expect(hook.result.current.selection.selectedChangeId).toBe(1);
  expect(hook.result.current.selection.hasNewerChanges).toBe(true);
});

it.each([1, 80])('keeps all unseen burst rows loadable with an old list of %i rows', async (initial) => {
  vi.useFakeTimers();
  const api = localApi(initial);
  const hook = renderHook(() => useFileChanges({ sessionId: 's1', enabled: true }));
  await act(flush);
  expect(hook.result.current.hasMore).toBe(initial > 50);
  api.replace(initial + 51);
  act(() => api.burst(51));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); await flush(); });
  expect(hook.result.current.hasMore).toBe(true);
  // Refresh again before filling the gap; cached older history must not become an overlap proof.
  api.replace(initial + 55);
  await act(async () => hook.result.current.retry());
  for (let page = 0; page < 5 && hook.result.current.hasMore; page++) {
    await act(async () => hook.result.current.loadMore());
  }
  expect(hook.result.current.hasMore).toBe(false);
  expect(hook.result.current.changes?.map((row) => row.id)).toEqual(
    records(initial + 55).map((row) => row.id),
  );
});

it('keeps the exhausted old cursor only when an overlapping head establishes continuity', async () => {
  const api = localApi(3);
  const hook = renderHook(() => useFileChanges({ sessionId: 's1', enabled: true }));
  await act(flush);
  api.replace(4);
  await act(async () => hook.result.current.retry());
  expect(hook.result.current.hasMore).toBe(false);
  expect(hook.result.current.loadedCount).toBe(4);
});

it.each(['session', 'workspace'])('fences pending Local pages at a %s identity change', async (boundary) => {
  const api = localApi(1);
  const stale = deferred();
  api.list.mockImplementationOnce(() => stale.promise);
  const hook = renderHook(({ sessionId, workspaceKey }) =>
    useFileChanges({ sessionId, workspaceKey, enabled: true }), {
    initialProps: { sessionId: 's1', workspaceKey: 'repo' },
  });
  api.replace(2);
  hook.rerender({ sessionId: boundary === 'session' ? 's2' : 's1', workspaceKey: 'worktree' });
  await act(flush);
  await act(async () => { stale.resolve({ items: [summary(99)], nextCursor: 'stale' }); await flush(); });
  expect(hook.result.current.changes?.map((row) => row.id)).toEqual([2, 1]);
  expect(hook.result.current.hasMore).toBe(false);
});

it('discards a stale Remote source result and prevents load-more from cancelling a new head', async () => {
  const oldPage = deferred();
  const refreshed = deferred();
  const oldRead = vi.fn(() => oldPage.promise);
  const newRead = vi.fn().mockResolvedValueOnce({ items: [summary(2)], nextCursor: '2' })
    .mockImplementationOnce(() => refreshed.promise);
  const hook = renderHook(({ identity, revision, readPage }) => useFileChangePages({
    identity, enabled: true, revision, readPage, errorMessage: () => 'error',
  }), { initialProps: { identity: 'remote-a:1', revision: 1, readPage: oldRead } });
  hook.rerender({ identity: 'remote-b:2', revision: 1, readPage: newRead });
  await act(flush);
  await act(async () => { oldPage.resolve({ items: [summary(100)], nextCursor: null }); await flush(); });
  expect(hook.result.current.changes?.map((row) => row.id)).toEqual([2]);
  hook.rerender({ identity: 'remote-b:2', revision: 2, readPage: newRead });
  await act(async () => hook.result.current.loadMore());
  expect(newRead).toHaveBeenCalledTimes(2);
  await act(async () => { refreshed.resolve({ items: [summary(3), summary(2)], nextCursor: '2' }); await flush(); });
  expect(hook.result.current.changes?.map((row) => row.id)).toEqual([3, 2]);
});

it('ignores disabled/unmounted results and reloads the same source on activation', async () => {
  const pending = deferred();
  const read = vi.fn().mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ items: [summary(2)], nextCursor: null });
  const hook = renderHook(({ enabled }) => useFileChangePages({
    identity: 'source', enabled, readPage: read, errorMessage: () => 'error',
  }), { initialProps: { enabled: true } });
  hook.rerender({ enabled: false });
  await act(async () => { pending.resolve({ items: [summary(1)], nextCursor: 'stale' }); await flush(); });
  expect(hook.result.current.changes).toBeNull();
  hook.rerender({ enabled: true });
  await act(flush);
  expect(hook.result.current.changes?.[0]?.id).toBe(2);
  hook.unmount();
});
