import { create } from 'zustand';
import type { IssueRecord, IssueStatus } from '@shared/types';

export const DEFAULT_ISSUE_QUERY_LIMIT = 500;
export const MAX_ISSUE_QUERY_DIRTY = 1_000;

export interface IssueFilters {
  statuses?: IssueStatus[];
  kinds?: string[];
  titleKeyword?: string;
  showDeleted?: boolean;
}

export interface ActiveIssueListRequest {
  id: number;
  limit: number;
  filterVersion: number;
  dirtyIssueIds: Set<string>;
  overflowed: boolean;
}

export type IssueListMergeOutcome = 'applied' | 'retry' | 'stale';

interface IssuesState {
  /** Authoritative records retained only for current query members and explicit pins. */
  issues: Map<string, IssueRecord>;
  /** Ordered membership of the current bounded list query. */
  queryIssueIds: string[];
  selectedIssueId: string | null;
  filters: IssueFilters;
  queryLimit: number;
  filterVersion: number;
  listRequestSerial: number;
  activeListRequest: ActiveIssueListRequest | null;

  beginListRequest: (limit?: number) => number;
  mergeIssuesFromList: (
    requestId: number,
    records: IssueRecord[],
  ) => IssueListMergeOutcome;
  cancelListRequest: (requestId: number) => void;
  upsertIssue: (record: IssueRecord) => void;
  removeIssue: (id: string) => void;
  selectIssue: (id: string | null) => void;
  setFilters: (filters: IssueFilters | ((prev: IssueFilters) => IssueFilters)) => void;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_ISSUE_QUERY_LIMIT;
  return Math.max(1, Math.min(DEFAULT_ISSUE_QUERY_LIMIT, Math.floor(value!)));
}

function matchesFilters(issue: IssueRecord, filters: IssueFilters): boolean {
  if (!filters.showDeleted && issue.deletedAt !== null) return false;
  if (filters.statuses?.length && !filters.statuses.includes(issue.status)) return false;
  if (filters.kinds?.length && !filters.kinds.includes(issue.kind)) return false;
  const keyword = filters.titleKeyword?.trim().toLowerCase();
  return !keyword || issue.title.toLowerCase().includes(keyword);
}

function compareIssues(a: IssueRecord, b: IssueRecord): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

function boundedMembership(
  issues: Map<string, IssueRecord>,
  candidates: Iterable<string>,
  filters: IssueFilters,
  limit: number,
): string[] {
  const unique = new Set(candidates);
  return [...unique]
    .map((id) => issues.get(id))
    .filter((issue): issue is IssueRecord => Boolean(issue && matchesFilters(issue, filters)))
    .sort(compareIssues)
    .slice(0, limit)
    .map((issue) => issue.id);
}

function mergeListRecord(
  existing: IssueRecord | undefined,
  incoming: IssueRecord,
): IssueRecord {
  if (existing && existing.updatedAt > incoming.updatedAt) return existing;
  if (incoming.appendices === undefined && existing?.appendices !== undefined) {
    return { ...incoming, appendices: existing.appendices };
  }
  return incoming;
}

function pruneEntities(
  issues: Map<string, IssueRecord>,
  queryIssueIds: Iterable<string>,
  selectedIssueId: string | null,
  dirtyIssueIds: Iterable<string> = [],
): Map<string, IssueRecord> {
  const retained = new Set(queryIssueIds);
  if (selectedIssueId) retained.add(selectedIssueId);
  for (const id of dirtyIssueIds) retained.add(id);
  const next = new Map<string, IssueRecord>();
  for (const id of retained) {
    const issue = issues.get(id);
    if (issue) next.set(id, issue);
  }
  return next;
}

function updateActiveRequest(
  active: ActiveIssueListRequest | null,
  issueId: string,
): ActiveIssueListRequest | null {
  if (!active || active.overflowed) return active;
  const dirtyIssueIds = new Set(active.dirtyIssueIds);
  dirtyIssueIds.add(issueId);
  if (dirtyIssueIds.size > MAX_ISSUE_QUERY_DIRTY) {
    return { ...active, dirtyIssueIds: new Set(), overflowed: true };
  }
  return { ...active, dirtyIssueIds };
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: new Map(),
  queryIssueIds: [],
  selectedIssueId: null,
  filters: { statuses: ['open', 'in-progress'], showDeleted: false },
  queryLimit: DEFAULT_ISSUE_QUERY_LIMIT,
  filterVersion: 0,
  listRequestSerial: 0,
  activeListRequest: null,

  beginListRequest: (requestedLimit) => {
    const state = get();
    const id = state.listRequestSerial + 1;
    const limit = normalizeLimit(requestedLimit);
    set({
      issues: pruneEntities(
        state.issues,
        state.queryIssueIds,
        state.selectedIssueId,
      ),
      queryLimit: limit,
      listRequestSerial: id,
      activeListRequest: {
        id,
        limit,
        filterVersion: state.filterVersion,
        dirtyIssueIds: new Set(),
        overflowed: false,
      },
    });
    return id;
  },

  mergeIssuesFromList: (requestId, records) => {
    let outcome: IssueListMergeOutcome = 'stale';
    set((state) => {
      const active = state.activeListRequest;
      if (
        !active ||
        active.id !== requestId ||
        active.filterVersion !== state.filterVersion
      ) {
        return {};
      }
      if (active.overflowed) {
        outcome = 'retry';
        return {
          issues: pruneEntities(
            state.issues,
            state.queryIssueIds,
            state.selectedIssueId,
          ),
          activeListRequest: null,
        };
      }

      outcome = 'applied';
      const candidates = new Map<string, IssueRecord>();
      for (const record of records) {
        candidates.set(
          record.id,
          mergeListRecord(state.issues.get(record.id), record),
        );
      }
      for (const id of active.dirtyIssueIds) {
        const current = state.issues.get(id);
        if (current && matchesFilters(current, state.filters)) {
          candidates.set(id, current);
        } else {
          candidates.delete(id);
        }
      }

      const queryIssueIds = boundedMembership(
        candidates,
        candidates.keys(),
        state.filters,
        active.limit,
      );
      const selected = state.selectedIssueId
        ? state.issues.get(state.selectedIssueId)
        : undefined;
      if (selected && !candidates.has(selected.id)) {
        candidates.set(selected.id, selected);
      }
      return {
        issues: pruneEntities(candidates, queryIssueIds, state.selectedIssueId),
        queryIssueIds,
        queryLimit: active.limit,
        activeListRequest: null,
      };
    });
    return outcome;
  },

  cancelListRequest: (requestId) => {
    set((state) => {
      if (state.activeListRequest?.id !== requestId) return {};
      return {
        issues: pruneEntities(
          state.issues,
          state.queryIssueIds,
          state.selectedIssueId,
        ),
        activeListRequest: null,
      };
    });
  },

  upsertIssue: (record) => {
    set((state) => {
      const existing = state.issues.get(record.id);
      if (existing && existing.updatedAt > record.updatedAt) return {};
      const issues = new Map(state.issues);
      issues.set(record.id, record);
      const candidates = new Set(state.queryIssueIds);
      if (matchesFilters(record, state.filters)) candidates.add(record.id);
      else candidates.delete(record.id);
      const queryIssueIds = boundedMembership(
        issues,
        candidates,
        state.filters,
        state.queryLimit,
      );
      const activeListRequest = updateActiveRequest(
        state.activeListRequest,
        record.id,
      );
      return {
        issues: pruneEntities(
          issues,
          queryIssueIds,
          state.selectedIssueId,
          activeListRequest && !activeListRequest.overflowed
            ? activeListRequest.dirtyIssueIds
            : [],
        ),
        queryIssueIds,
        activeListRequest,
      };
    });
  },

  removeIssue: (id) => {
    set((state) => {
      const issues = new Map(state.issues);
      issues.delete(id);
      const queryIssueIds = state.queryIssueIds.filter((candidate) => candidate !== id);
      const activeListRequest = updateActiveRequest(state.activeListRequest, id);
      const selectedIssueId = state.selectedIssueId === id ? null : state.selectedIssueId;
      return {
        issues: pruneEntities(
          issues,
          queryIssueIds,
          selectedIssueId,
          activeListRequest && !activeListRequest.overflowed
            ? activeListRequest.dirtyIssueIds
            : [],
        ),
        queryIssueIds,
        selectedIssueId,
        activeListRequest,
      };
    });
  },

  selectIssue: (id) => {
    set((state) => ({
      selectedIssueId: id,
      issues: pruneEntities(
        state.issues,
        state.queryIssueIds,
        id,
        state.activeListRequest && !state.activeListRequest.overflowed
          ? state.activeListRequest.dirtyIssueIds
          : [],
      ),
    }));
  },

  setFilters: (filters) => {
    set((state) => {
      const nextFilters = typeof filters === 'function'
        ? filters(state.filters)
        : filters;
      return {
        filters: nextFilters,
        filterVersion: state.filterVersion + 1,
        activeListRequest: null,
        issues: pruneEntities(
          state.issues,
          state.queryIssueIds,
          state.selectedIssueId,
        ),
      };
    });
  },
}));

export function selectFilteredIssues(
  state: Pick<IssuesState, 'issues' | 'queryIssueIds' | 'filters'>,
): IssueRecord[] {
  return state.queryIssueIds
    .map((id) => state.issues.get(id))
    .filter((issue): issue is IssueRecord => Boolean(
      issue && matchesFilters(issue, state.filters),
    ))
    .sort(compareIssues);
}
