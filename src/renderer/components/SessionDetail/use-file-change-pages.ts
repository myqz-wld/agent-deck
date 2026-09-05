import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileChangePage } from '@shared/types';
import {
  appendFileChangePage, EMPTY_FILE_CHANGE_PAGES, refreshFileChangePages,
  type FileChangeLoadSummary, type FileChangePages,
} from './file-change-pages';

interface FileChangePagesOptions {
  identity: string;
  enabled: boolean;
  revision?: number;
  readPage(cursor?: string): Promise<FileChangePage>;
  errorMessage(reason: unknown, more: boolean): string;
}

/** Shared paging policy; the caller retains source identity, authorization and transport reads. */
export function useFileChangePages(options: FileChangePagesOptions) {
  const { identity, enabled, revision } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [pages, setPages] = useState<FileChangePages>(EMPTY_FILE_CHANGE_PAGES);
  const pagesRef = useRef(pages);
  const generation = useRef(0);
  const paging = useRef(false);
  const refreshing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastLoadSummary, setLastLoadSummary] = useState<FileChangeLoadSummary | null>(null);
  const commit = useCallback((next: FileChangePages) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  useLayoutEffect(() => {
    generation.current += 1;
    paging.current = false;
    refreshing.current = false;
    commit(EMPTY_FILE_CHANGE_PAGES);
    setError(null);
    setLoadingMore(false);
    setLastLoadSummary(null);
    return () => { generation.current += 1; };
  }, [identity, commit]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!optionsRef.current.enabled) return;
    const current = ++generation.current;
    const { readPage, errorMessage } = optionsRef.current;
    refreshing.current = true;
    paging.current = false;
    setLoadingMore(false);
    setError(null);
    try {
      const page = await readPage();
      if (current !== generation.current) return;
      commit(refreshFileChangePages(pagesRef.current, page));
    } catch (reason) {
      if (current === generation.current) setError(errorMessage(reason, false));
    } finally {
      if (current === generation.current) refreshing.current = false;
    }
  }, [commit]);

  useEffect(() => {
    if (enabled) void refresh();
    return () => { generation.current += 1; };
  }, [identity, enabled, revision, refresh]);

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = pagesRef.current.nextCursor;
    if (!optionsRef.current.enabled || !cursor || paging.current || refreshing.current) return;
    const current = ++generation.current;
    const { readPage, errorMessage } = optionsRef.current;
    paging.current = true;
    setLoadingMore(true);
    setLastLoadSummary(null);
    try {
      const page = await readPage(cursor);
      if (current !== generation.current) return;
      const appended = appendFileChangePage(pagesRef.current, page);
      commit(appended.pages);
      setLastLoadSummary(appended.summary);
      setError(null);
    } catch (reason) {
      if (current === generation.current) setError(errorMessage(reason, true));
    } finally {
      if (current === generation.current) {
        paging.current = false;
        setLoadingMore(false);
      }
    }
  }, [commit]);

  return {
    changes: pages.changes,
    hasMore: pages.nextCursor !== null,
    loadedCount: pages.changes?.length ?? 0,
    error, loadingMore, lastLoadSummary, loadMore, retry: refresh,
  };
}
