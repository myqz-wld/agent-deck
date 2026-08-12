import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionPresentationCountsDto } from '@contracts/index';
import { REMOTE_HOST_PAGE_LIMIT, remoteSessionPageRequest } from '@shared/remote-host';
import type {
  RemoteHostPendingIndexBucketDto,
  RemoteHostPendingListDto,
  RemoteHostResourceRevisions,
  RemoteHostSessionPresentationDto,
  RemoteHostSessionPresentationPageDto,
} from '@shared/remote-host';

import { appendUnique } from './remote-source-utils';
import { legacyRemoteSessionPresentation } from './session-summary-presentation';
import { useRemoteRefreshLane } from './use-remote-refresh-lane';

const EMPTY_PENDING = new Map<string, RemoteHostPendingListDto>();
const PENDING_PAGE_LIMIT = 25;

interface RemotePresentationListsOptions {
  activeProfileId: string | null;
  capabilities: ReadonlySet<string>;
  identity: string;
  localRevision: number;
  resourceRevisions: RemoteHostResourceRevisions;
  usable: boolean;
}

export interface RemotePresentationLists {
  sessions: readonly RemoteHostSessionPresentationDto[];
  historySessions: readonly RemoteHostSessionPresentationDto[];
  counts: SessionPresentationCountsDto | null;
  total: number | null;
  loading: boolean;
  error: string | null;
  historyLoading: boolean;
  historyLoadError: string | null;
  historyQuery: string;
  hasMoreSessions: boolean;
  hasMoreHistorySessions: boolean;
  pendingBuckets: readonly RemoteHostPendingIndexBucketDto[];
  pendingBySession: ReadonlyMap<string, RemoteHostPendingListDto>;
  pendingLoading: boolean;
  pendingLoadError: string | null;
  pendingTotal: number | null;
  pendingScanTruncated: boolean;
  hasMorePending: boolean;
  livePaginationBusy: boolean;
  historyPaginationBusy: boolean;
  pendingPaginationBusy: boolean;
  loadMoreSessions(): Promise<void>;
  loadMoreHistorySessions(): Promise<void>;
  loadMorePending(): Promise<void>;
  clearErrors(): void;
  mergePending(sessionId: string, pending: RemoteHostPendingListDto | null): void;
  setHistoryQuery(query: string): void;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function mergePendingMap(
  current: ReadonlyMap<string, RemoteHostPendingListDto>,
  incoming: Iterable<readonly [string, RemoteHostPendingListDto]>,
): ReadonlyMap<string, RemoteHostPendingListDto> {
  const next = new Map(current);
  for (const [sessionId, pending] of incoming) {
    const previous = next.get(sessionId);
    if (!previous || pending.revision >= previous.revision) next.set(sessionId, pending);
  }
  return next;
}

function mergePendingSnapshot(
  current: ReadonlyMap<string, RemoteHostPendingListDto>,
  buckets: readonly RemoteHostPendingIndexBucketDto[],
  revision: number,
  complete: boolean,
): ReadonlyMap<string, RemoteHostPendingListDto> {
  const base = complete
    ? new Map([...current].filter(([, pending]) => pending.revision > revision))
    : current;
  return mergePendingMap(base, buckets.map((bucket) => [bucket.session.id, bucket.pending] as const));
}

function mergePendingBuckets(
  current: readonly RemoteHostPendingIndexBucketDto[],
  incoming: readonly RemoteHostPendingIndexBucketDto[],
  replace: boolean,
): RemoteHostPendingIndexBucketDto[] {
  const previous = new Map(current.map((bucket) => [bucket.session.id, bucket]));
  const bounded = incoming.map((bucket) => {
    const existing = previous.get(bucket.session.id);
    return existing && existing.pending.revision > bucket.pending.revision ? existing : bucket;
  });
  return replace ? bounded : appendUnique(current, bounded, (bucket) => bucket.session.id)
    .map((bucket) => bounded.find((candidate) => candidate.session.id === bucket.session.id) ?? bucket);
}

export function useRemotePresentationLists(
  options: RemotePresentationListsOptions,
): RemotePresentationLists {
  const {
    activeProfileId, capabilities, identity, localRevision, resourceRevisions, usable,
  } = options;
  const [sessions, setSessions] = useState<RemoteHostSessionPresentationDto[]>([]);
  const [historySessions, setHistorySessions] = useState<RemoteHostSessionPresentationDto[]>([]);
  const [counts, setCounts] = useState<SessionPresentationCountsDto | null>(null);
  const [sessionTotal, setSessionTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [historyQuery, setHistoryQueryState] = useState('');
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [pendingCursor, setPendingCursor] = useState<string | null>(null);
  const [pendingBuckets, setPendingBuckets] = useState<RemoteHostPendingIndexBucketDto[]>([]);
  const [pendingBySession, setPendingBySession] =
    useState<ReadonlyMap<string, RemoteHostPendingListDto>>(EMPTY_PENDING);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingLoadError, setPendingLoadError] = useState<string | null>(null);
  const [pendingTotal, setPendingTotal] = useState<number | null>(null);
  const [pendingScanTruncated, setPendingScanTruncated] = useState(false);
  const [paginationBusy, setPaginationBusy] = useState({
    live: false, history: false, pending: false,
  });
  const [reloads, setReloads] = useState({ live: 0, history: 0, pending: 0 });
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const historyQueryRef = useRef(historyQuery);
  historyQueryRef.current = historyQuery;
  const cursorRefs = useRef({ live: sessionCursor, history: historyCursor, pending: pendingCursor });
  cursorRefs.current = { live: sessionCursor, history: historyCursor, pending: pendingCursor };
  const baseRevisions = useRef({ live: 0, history: 0, pending: 0 });
  const paginationGeneration = useRef({ live: 0, history: 0, pending: 0 });
  const canRich = usable && capabilities.has('sessions.presentation.read');
  const canLegacy = usable && capabilities.has('session-console.read');
  const canHistory = canRich || (canLegacy && capabilities.has('sessions.history'));
  const canPending = usable && capabilities.has('pending.index.read');
  const liveTrigger = `${resourceRevisions['session-list']}:${localRevision}:${reloads.live}`;
  const historyTrigger = `${resourceRevisions['session-list']}:${localRevision}:${reloads.history}:${historyQuery}`;
  const pendingTrigger = `${resourceRevisions.pending}:${localRevision}:${reloads.pending}`;
  const triggerRefs = useRef({ live: liveTrigger, history: historyTrigger, pending: pendingTrigger });
  triggerRefs.current = { live: liveTrigger, history: historyTrigger, pending: pendingTrigger };

  useEffect(() => {
    paginationGeneration.current.live += 1;
    setPaginationBusy((current) => ({ ...current, live: false }));
  }, [identity, usable, liveTrigger]);
  useEffect(() => {
    paginationGeneration.current.history += 1;
    setPaginationBusy((current) => ({ ...current, history: false }));
  }, [identity, usable, historyTrigger]);
  useEffect(() => {
    paginationGeneration.current.pending += 1;
    setPaginationBusy((current) => ({ ...current, pending: false }));
  }, [identity, usable, pendingTrigger]);

  useEffect(() => {
    setSessions([]);
    setHistorySessions([]);
    setCounts(null);
    setSessionTotal(null);
    setLoading(false);
    setError(null);
    setHistoryLoading(false);
    setHistoryLoadError(null);
    setSessionCursor(null);
    setHistoryCursor(null);
    setPendingCursor(null);
    setPendingBuckets([]);
    setPendingBySession(EMPTY_PENDING);
    setPendingLoading(false);
    setPendingLoadError(null);
    setPendingTotal(null);
    setPendingScanTruncated(false);
    baseRevisions.current = { live: 0, history: 0, pending: 0 };
  }, [identity, usable]);

  useRemoteRefreshLane({
    enabled: Boolean(activeProfileId && (canRich || canLegacy)), identity, trigger: liveTrigger,
    run: async (isCurrent) => {
      if (!activeProfileId) return;
      setLoading(true);
      try {
        if (canRich) {
          const page = await window.api.listRemoteHostSessionPresentations({
            profileId: activeProfileId, kind: 'live', limit: REMOTE_HOST_PAGE_LIMIT,
          });
          if (!isCurrent()) return;
          setSessions(page.sessions);
          setCounts(page.counts);
          setSessionTotal(page.counts.total);
          setSessionCursor(page.nextCursor);
          baseRevisions.current.live = page.revision;
          setError(page.contextTruncated ? '部分层级因有界读取未展开；可刷新后重试。' : null);
        } else {
          const page = await window.api.listRemoteHostSessions(remoteSessionPageRequest(
            activeProfileId, REMOTE_HOST_PAGE_LIMIT, { includeArchived: false },
          ));
          if (!isCurrent()) return;
          const rows = page.sessions.map(legacyRemoteSessionPresentation);
          setSessions(rows);
          setCounts(null);
          setSessionTotal(page.total);
          setSessionCursor(page.nextCursor);
          baseRevisions.current.live = page.revision;
          setError(null);
        }
      } catch (reason) {
        if (isCurrent()) setError(message(reason));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
  });

  useRemoteRefreshLane({
    enabled: Boolean(activeProfileId && canHistory), identity, trigger: historyTrigger,
    run: async (isCurrent) => {
      if (!activeProfileId) return;
      const query = historyQuery.trim();
      setHistoryLoading(true);
      try {
        if (canRich) {
          const page = await window.api.listRemoteHostSessionPresentations({
            profileId: activeProfileId, kind: 'history', limit: REMOTE_HOST_PAGE_LIMIT,
            ...(query ? { query } : {}),
          });
          if (!isCurrent()) return;
          setHistorySessions(page.sessions);
          setHistoryCursor(page.nextCursor);
          baseRevisions.current.history = page.revision;
          setHistoryLoadError(null);
        } else {
          const page = await window.api.listRemoteHostSessions(remoteSessionPageRequest(
            activeProfileId, REMOTE_HOST_PAGE_LIMIT, { includeArchived: true },
          ));
          if (!isCurrent()) return;
          setHistorySessions(page.sessions.map(legacyRemoteSessionPresentation));
          setHistoryCursor(page.nextCursor);
          baseRevisions.current.history = page.revision;
          setHistoryLoadError(query ? '旧版 Remote Core 只能搜索当前载入的历史摘要。' : null);
        }
      } catch (reason) {
        if (isCurrent()) setHistoryLoadError(message(reason));
      } finally {
        if (isCurrent()) setHistoryLoading(false);
      }
    },
  });

  useRemoteRefreshLane({
    enabled: Boolean(activeProfileId && canPending), identity, trigger: pendingTrigger,
    run: async (isCurrent) => {
      if (!activeProfileId) return;
      setPendingLoading(true);
      try {
        const page = await window.api.listRemoteHostPendingIndex({
          profileId: activeProfileId, limit: PENDING_PAGE_LIMIT,
        });
        if (!isCurrent()) return;
        setPendingBuckets((current) => mergePendingBuckets(current, page.buckets, true));
        setPendingBySession((current) => mergePendingSnapshot(
          current, page.buckets, page.revision, page.nextCursor === null,
        ));
        setPendingCursor(page.nextCursor);
        setPendingTotal(page.totalRequests);
        setPendingScanTruncated(page.scanTruncated);
        baseRevisions.current.pending = page.revision;
        setPendingLoadError(null);
      } catch (reason) {
        if (isCurrent()) setPendingLoadError(message(reason));
      } finally {
        if (isCurrent()) setPendingLoading(false);
      }
    },
  });

  const mergePending = useCallback((
    sessionId: string,
    pending: RemoteHostPendingListDto | null,
  ): void => {
    setPendingBySession((current) => {
      if (pending) return mergePendingMap(current, [[sessionId, pending]]);
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    setPendingBuckets((current) => pending
      ? current.map((bucket) => bucket.session.id === sessionId &&
          pending.revision >= bucket.pending.revision ? { ...bucket, pending } : bucket)
      : current.filter((bucket) => bucket.session.id !== sessionId));
  }, []);

  const loadMore = useCallback(async (kind: 'history' | 'live' | 'pending'): Promise<void> => {
    if (!activeProfileId || !usable) return;
    const cursor = cursorRefs.current[kind];
    if (!cursor) return;
    const generation = ++paginationGeneration.current[kind];
    const expectedIdentity = identityRef.current;
    const expectedTrigger = triggerRefs.current[kind];
    const expectedRevision = baseRevisions.current[kind];
    const expectedQuery = historyQueryRef.current.trim();
    const current = (): boolean => identityRef.current === expectedIdentity &&
      generation === paginationGeneration.current[kind] &&
      triggerRefs.current[kind] === expectedTrigger &&
      cursorRefs.current[kind] === cursor;
    setPaginationBusy((value) => ({ ...value, [kind]: true }));
    try {
      if (kind === 'pending') {
        if (!canPending) return;
        const page = await window.api.listRemoteHostPendingIndex({
          profileId: activeProfileId, cursor, limit: PENDING_PAGE_LIMIT,
        });
        if (!current()) return;
        if (page.revision !== expectedRevision) {
          setReloads((value) => ({ ...value, pending: value.pending + 1 }));
          return;
        }
        setPendingBuckets((value) => mergePendingBuckets(value, page.buckets, false));
        setPendingBySession((value) => mergePendingMap(
          value, page.buckets.map((bucket) => [bucket.session.id, bucket.pending] as const),
        ));
        setPendingCursor(page.nextCursor);
        setPendingTotal(page.totalRequests);
        setPendingScanTruncated(page.scanTruncated);
        setPendingLoadError(null);
        return;
      }
      const isHistory = kind === 'history';
      let page: Omit<RemoteHostSessionPresentationPageDto, 'counts'> & {
        counts: SessionPresentationCountsDto | null;
        total: number | null;
      };
      if (canRich) {
        const rich = await window.api.listRemoteHostSessionPresentations({
          profileId: activeProfileId, kind, cursor, limit: REMOTE_HOST_PAGE_LIMIT,
          ...(isHistory && expectedQuery ? { query: expectedQuery } : {}),
        });
        page = { ...rich, total: rich.counts.total };
      } else {
        const legacy = await window.api.listRemoteHostSessions(remoteSessionPageRequest(
          activeProfileId, REMOTE_HOST_PAGE_LIMIT, { cursor, includeArchived: isHistory },
        ));
        const rows = legacy.sessions.map(legacyRemoteSessionPresentation);
        page = {
          sessions: rows, nextCursor: legacy.nextCursor,
          counts: null, contextTruncated: false,
          revision: legacy.revision, total: legacy.total,
        };
      }
      if (!current() || (isHistory && historyQueryRef.current.trim() !== expectedQuery)) return;
      if (page.revision !== expectedRevision) {
        setReloads((value) => ({ ...value, [kind]: value[kind] + 1 }));
        return;
      }
      if (isHistory) {
        setHistorySessions((value) => appendUnique(value, page.sessions, (row) => row.id));
        setHistoryCursor(page.nextCursor);
        setHistoryLoadError(null);
      } else {
        setSessions((value) => appendUnique(value, page.sessions, (row) => row.id));
        setSessionCursor(page.nextCursor);
        setCounts(page.counts);
        setSessionTotal(page.total);
        setError(page.contextTruncated ? '部分层级因有界读取未展开；可刷新后重试。' : null);
      }
    } catch (reason) {
      if (!current()) return;
      if (kind === 'history') setHistoryLoadError(message(reason));
      else if (kind === 'pending') setPendingLoadError(message(reason));
      else setError(message(reason));
    } finally {
      if (current()) setPaginationBusy((value) => ({ ...value, [kind]: false }));
    }
  }, [activeProfileId, canPending, canRich, usable]);

  return {
    sessions: usable ? sessions : [], historySessions: usable ? historySessions : [],
    counts: usable ? counts : null, total: usable ? sessionTotal : null,
    loading: usable && loading,
    error: usable ? error : null, historyLoading: usable && historyLoading,
    historyLoadError: usable ? historyLoadError : null, historyQuery,
    hasMoreSessions: usable && sessionCursor !== null,
    hasMoreHistorySessions: usable && historyCursor !== null,
    pendingBuckets: usable ? pendingBuckets : [],
    pendingBySession: usable ? pendingBySession : EMPTY_PENDING,
    pendingLoading: usable && pendingLoading,
    pendingLoadError: usable ? pendingLoadError : null,
    pendingTotal: usable ? pendingTotal : null,
    pendingScanTruncated: usable && pendingScanTruncated,
    hasMorePending: usable && pendingCursor !== null,
    livePaginationBusy: usable && paginationBusy.live,
    historyPaginationBusy: usable && paginationBusy.history,
    pendingPaginationBusy: usable && paginationBusy.pending,
    loadMoreSessions: () => loadMore('live'),
    loadMoreHistorySessions: () => loadMore('history'),
    loadMorePending: () => loadMore('pending'),
    clearErrors: () => { setError(null); setHistoryLoadError(null); setPendingLoadError(null); },
    mergePending,
    setHistoryQuery: (query) => setHistoryQueryState(query.slice(0, 512)),
  };
}
