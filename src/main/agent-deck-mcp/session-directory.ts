import type { SessionRecord } from '@shared/types';

export interface SessionDirectoryQuery {
  statusFilter?: 'open' | 'active' | 'dormant' | 'closed' | 'all';
  adapterFilter?: string;
  spawnedByFilter?: string;
  titleFilter?: string;
  cwdFilter?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface SessionDirectoryRepository {
  listActiveAndDormant(
    limit: number, offset: number, lifecycle?: 'active' | 'dormant',
    spawnedBy?: string, agentId?: string,
  ): SessionRecord[];
  listHistory(options: {
    limit: number; offset: number; spawnedBy?: string; agentId?: string;
  }): SessionRecord[];
}

const PAGE_SIZE = 200;

function* pages(read: (limit: number, offset: number) => SessionRecord[]) {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const rows = read(PAGE_SIZE, offset);
    yield* rows;
    if (rows.length < PAGE_SIZE) return;
  }
}

/** Merge bounded database pages, never a growing prefix capped by the History repository. */
function* candidates(repo: SessionDirectoryRepository, args: SessionDirectoryQuery) {
  const status = args.statusFilter ?? 'open';
  const live = pages((limit, offset) => repo.listActiveAndDormant(
    limit, offset, status === 'active' || status === 'dormant' ? status : undefined,
    args.spawnedByFilter, args.adapterFilter,
  ));
  const history = pages((limit, offset) => repo.listHistory({
    limit, offset, spawnedBy: args.spawnedByFilter, agentId: args.adapterFilter,
  }));
  if (status === 'closed') { yield* history; return; }
  if (status !== 'all') { yield* live; return; }
  let a = live.next();
  let b = history.next();
  while (!a.done || !b.done) {
    if (b.done || (!a.done && (a.value.lastEventAt ?? 0) >= (b.value.lastEventAt ?? 0))) {
      yield a.value!;
      a = live.next();
    } else {
      yield b.value;
      b = history.next();
    }
  }
}

export function collectSessionDirectory(
  repo: SessionDirectoryRepository,
  args: SessionDirectoryQuery,
  visible: (session: SessionRecord) => boolean,
): { page: SessionRecord[]; hasMore: boolean } {
  const page: SessionRecord[] = [];
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  let skipped = 0;
  for (const row of candidates(repo, args)) {
    if (row.hiddenFromHistory || (!args.includeArchived && row.archivedAt != null)) continue;
    const status = args.statusFilter ?? 'open';
    if (status === 'open' && row.lifecycle === 'closed') continue;
    if (['active', 'dormant', 'closed'].includes(status) && row.lifecycle !== status) continue;
    if (args.adapterFilter && row.agentId !== args.adapterFilter) continue;
    if (args.spawnedByFilter && row.spawnedBy !== args.spawnedByFilter) continue;
    if (args.titleFilter && !row.title.toLocaleLowerCase().includes(args.titleFilter.toLocaleLowerCase())) continue;
    if (args.cwdFilter && !row.cwd.includes(args.cwdFilter)) continue;
    if (!visible(row)) continue;
    if (skipped < offset) { skipped++; continue; }
    if (page.length === limit) return { page, hasMore: true };
    page.push(row);
  }
  return { page, hasMore: false };
}
