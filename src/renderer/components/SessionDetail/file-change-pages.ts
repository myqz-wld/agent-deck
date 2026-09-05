import type { FileChangePage, FileChangeSummary } from '@shared/types';

export interface FileChangeLoadSummary {
  addedChangeCount: number;
  addedFileCount: number;
  exhausted: boolean;
}

export interface FileChangePages {
  readonly changes: FileChangeSummary[] | null;
  /** Only this window is known to be contiguous with the current head. Cached history may not be. */
  readonly window: readonly FileChangeSummary[];
  readonly nextCursor: string | null;
}

export const EMPTY_FILE_CHANGE_PAGES: FileChangePages = {
  changes: null, window: [], nextCursor: null,
};

function compare(left: FileChangeSummary, right: FileChangeSummary): number {
  return right.ts - left.ts || right.id - left.id;
}

function merge(current: readonly FileChangeSummary[], incoming: readonly FileChangeSummary[]) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(compare);
}

export function refreshFileChangePages(current: FileChangePages, page: FileChangePage): FileChangePages {
  const ids = new Set(current.window.map((item) => item.id));
  const overlaps = page.items.some((item) => ids.has(item.id));
  const oldTail = current.window.at(-1);
  const newTail = page.items.at(-1);
  // Retain the old cursor only when the new head joins its contiguous window and ends before
  // its frontier. Otherwise walk the new cursor, even when cached history already has older rows.
  const keepCursor = overlaps && oldTail && newTail && compare(newTail, oldTail) < 0;
  return {
    changes: merge(current.changes ?? [], page.items),
    window: overlaps ? merge(current.window, page.items) : page.items,
    nextCursor: keepCursor ? current.nextCursor : page.nextCursor,
  };
}

export function appendFileChangePage(current: FileChangePages, page: FileChangePage): {
  pages: FileChangePages;
  summary: FileChangeLoadSummary;
} {
  const existing = current.changes ?? [];
  const ids = new Set(existing.map((item) => item.id));
  const paths = new Set(existing.map((item) => item.filePath));
  const added = page.items.filter((item) => !ids.has(item.id));
  return {
    pages: {
      changes: merge(existing, page.items),
      window: merge(current.window, page.items),
      nextCursor: page.nextCursor,
    },
    summary: {
      addedChangeCount: added.length,
      addedFileCount: new Set(added.filter((item) => !paths.has(item.filePath))
        .map((item) => item.filePath)).size,
      exhausted: page.nextCursor === null,
    },
  };
}
