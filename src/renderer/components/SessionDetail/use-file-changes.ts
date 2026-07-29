import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileChangePayload, FileChangeSummary } from '@shared/types';

const PAGE_SIZE = 50;
const REFRESH_DELAY_MS = 300;

interface UseFileChangesArgs {
  sessionId: string;
  enabled: boolean;
  selectedChangeId: number | null;
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
  selectedChangeId,
}: UseFileChangesArgs) {
  const [changes, setChanges] = useState<FileChangeSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedPayload, setSelectedPayload] = useState<FileChangePayload | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const pageGeneration = useRef(0);
  const payloadGeneration = useRef(0);
  const payloadCache = useRef(new Map<number, FileChangePayload>());

  useEffect(() => {
    pageGeneration.current += 1;
    payloadGeneration.current += 1;
    payloadCache.current.clear();
    setChanges(null);
    setNextCursor(null);
    setError(null);
    setLoadingMore(false);
    setSelectedPayload(null);
    setPayloadLoading(false);
    setPayloadError(null);
  }, [sessionId]);

  const loadFirstPage = useCallback(
    async (incremental: boolean): Promise<void> => {
      const generation = ++pageGeneration.current;
      setLoadingMore(false);
      setError(null);
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
    try {
      const page = await window.api.listFileChangePage(sessionId, {
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (generation !== pageGeneration.current) return;
      setChanges((current) => mergeSummaries(current ?? [], page.items));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch {
      if (generation === pageGeneration.current) setError('无法加载更多文件改动。');
    } finally {
      if (generation === pageGeneration.current) setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, sessionId]);

  const retry = useCallback(
    () => loadFirstPage(changes !== null),
    [changes, loadFirstPage],
  );

  useEffect(() => {
    const generation = ++payloadGeneration.current;
    if (selectedChangeId == null) {
      setSelectedPayload(null);
      setPayloadLoading(false);
      setPayloadError(null);
      return;
    }
    const cached = payloadCache.current.get(selectedChangeId);
    if (cached) {
      setSelectedPayload(cached);
      setPayloadLoading(false);
      setPayloadError(null);
      return;
    }
    setSelectedPayload(null);
    setPayloadLoading(true);
    setPayloadError(null);
    void window.api
      .getFileChange(sessionId, selectedChangeId)
      .then((payload) => {
        if (generation !== payloadGeneration.current) return;
        if (!payload) {
          setPayloadError('找不到当前会话中的文件改动。');
          return;
        }
        payloadCache.current.set(selectedChangeId, payload);
        setSelectedPayload(payload);
      })
      .catch(() => {
        if (generation === payloadGeneration.current) {
          setPayloadError('无法加载所选文件改动。');
        }
      })
      .finally(() => {
        if (generation === payloadGeneration.current) setPayloadLoading(false);
      });
  }, [selectedChangeId, sessionId]);

  return {
    changes,
    error,
    hasMore: nextCursor !== null,
    loadingMore,
    loadMore,
    retry,
    selectedPayload,
    payloadLoading,
    payloadError,
  };
}
