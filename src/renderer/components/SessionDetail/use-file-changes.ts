import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileChangeSummary } from '@shared/types';

const PAGE_SIZE = 50;
const REFRESH_DELAY_MS = 300;

interface UseFileChangesArgs {
  sessionId: string;
  enabled: boolean;
  /** Resets renderer caches when one session crosses a cwd/worktree boundary. */
  workspaceKey?: string;
}

export interface FileChangeLoadSummary {
  addedChangeCount: number;
  addedFileCount: number;
  exhausted: boolean;
}

function mergeSummaries(
  current: FileChangeSummary[],
  incoming: FileChangeSummary[],
): FileChangeSummary[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.ts - a.ts || b.id - a.id);
}

export function useFileChanges({
  sessionId,
  enabled,
  workspaceKey = sessionId,
}: UseFileChangesArgs) {
  const [changes, setChanges] = useState<FileChangeSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastLoadSummary, setLastLoadSummary] = useState<FileChangeLoadSummary | null>(null);
  const pageGeneration = useRef(0);

  useLayoutEffect(() => {
    pageGeneration.current += 1;
    setChanges(null);
    setNextCursor(null);
    setError(null);
    setLoadingMore(false);
    setLastLoadSummary(null);
  }, [sessionId, workspaceKey]);

  const loadFirstPage = useCallback(
    async (incremental: boolean): Promise<void> => {
      const generation = ++pageGeneration.current;
      setLoadingMore(false);
      setError(null);
      if (!incremental) setLastLoadSummary(null);
      try {
        const page = await window.api.listFileChangePage(sessionId, { limit: PAGE_SIZE });
        if (generation !== pageGeneration.current) return;
        setChanges((current) =>
          incremental && current ? mergeSummaries(current, page.items) : page.items,
        );
        setNextCursor((current) => (incremental ? current : page.nextCursor));
        setError(null);
      } catch {
        if (generation === pageGeneration.current) setError('无法加载文件改动。');
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!enabled || changes !== null) return;
    void loadFirstPage(false);
  }, [changes, enabled, loadFirstPage]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.api.onAgentEvent((event) => {
      if (event.sessionId !== sessionId || event.kind !== 'file-changed' || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void loadFirstPage(true);
      }, REFRESH_DELAY_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [enabled, loadFirstPage, sessionId]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor || loadingMore) return;
    const generation = ++pageGeneration.current;
    setLoadingMore(true);
    setLastLoadSummary(null);
    try {
      const page = await window.api.listFileChangePage(sessionId, {
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (generation !== pageGeneration.current) return;
      const current = changes ?? [];
      const currentIds = new Set(current.map((item) => item.id));
      const currentPaths = new Set(current.map((item) => item.filePath));
      const addedItems = page.items.filter((item) => !currentIds.has(item.id));
      setChanges(mergeSummaries(current, page.items));
      setNextCursor(page.nextCursor);
      setLastLoadSummary({
        addedChangeCount: addedItems.length,
        addedFileCount: new Set(
          addedItems
            .filter((item) => !currentPaths.has(item.filePath))
            .map((item) => item.filePath),
        ).size,
        exhausted: page.nextCursor === null,
      });
      setError(null);
    } catch {
      if (generation === pageGeneration.current) setError('无法加载更多文件改动。');
    } finally {
      if (generation === pageGeneration.current) setLoadingMore(false);
    }
  }, [changes, loadingMore, nextCursor, sessionId]);

  const retry = useCallback(
    () => loadFirstPage(changes !== null),
    [changes, loadFirstPage],
  );

  return {
    changes,
    error,
    hasMore: nextCursor !== null,
    loadedCount: changes?.length ?? 0,
    loadingMore,
    lastLoadSummary,
    loadMore,
    retry,
  };
}
