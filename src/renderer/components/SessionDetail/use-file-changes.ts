import { useEffect } from 'react';
import { useFileChangePages } from './use-file-change-pages';

const PAGE_SIZE = 50;
const REFRESH_DELAY_MS = 300;

interface UseFileChangesArgs {
  sessionId: string;
  enabled: boolean;
  /** Resets renderer caches when one session crosses a cwd/worktree boundary. */
  workspaceKey?: string;
}

export type { FileChangeLoadSummary } from './file-change-pages';

export function useFileChanges({ sessionId, enabled, workspaceKey = sessionId }: UseFileChangesArgs) {
  const pages = useFileChangePages({
    identity: JSON.stringify([sessionId, workspaceKey]),
    enabled,
    readPage: (cursor) => window.api.listFileChangePage(sessionId, {
      limit: PAGE_SIZE, ...(cursor ? { cursor } : {}),
    }),
    errorMessage: (_reason, more) => more ? '无法加载更多文件改动。' : '无法加载文件改动。',
  });
  const refresh = pages.retry;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.api.onAgentEvent((event) => {
      if (event.sessionId !== sessionId || event.kind !== 'file-changed' || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, REFRESH_DELAY_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [enabled, refresh, sessionId, workspaceKey]);
  return pages;
}
