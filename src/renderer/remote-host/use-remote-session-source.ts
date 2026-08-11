import { useCallback, useEffect, useRef, useState } from 'react';
import { REMOTE_HOST_PAGE_LIMIT, remoteSessionPageRequest } from '@shared/remote-host';
import type {
  RemoteHostPendingListDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostSessionPageDto,
  RemoteHostSessionSummaryDto,
  RemoteHostSummaryListDto,
  RemoteHostSessionContextDto,
  RemoteHostSessionInputCapabilitiesDto,
} from '@shared/remote-host';
import type { RemoteSessionSourceView } from './source-types';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import {
  RemoteUserIntentLedger,
} from './remote-intent-ledger';
import { appendUnique, remoteSourceIdentity } from './remote-source-utils';
import { useRemoteSourceContext } from './use-remote-source-context';
import { createRemoteDetailReaders } from './remote-detail-readers';
import { startRemoteSessionDetailLoad } from './remote-session-detail-load';
import { useRemoteTaskRecords } from './use-remote-task-records';
import { useRemoteEventRecords } from './use-remote-event-records';
import { RemotePlanReviewTransports } from './remote-plan-review-transports';
import { useRemotePendingHydrator } from './use-remote-pending-hydrator';
import { useRemoteBusinessRunner } from './use-remote-business-runner';
import { createRemoteSessionActions } from './remote-session-actions';
const EMPTY_PENDING = new Map<string, RemoteHostPendingListDto>();

export function useRemoteSessionSource(hosts: RemoteHostSnapshotState): RemoteSessionSourceView {
  const {
    activeProfileId, capabilities, dataRevision, identity, profile,
    recoveringWorker, state, usable,
  } = useRemoteSourceContext(hosts);
  const [sessions, setSessions] = useState<RemoteHostSessionSummaryDto[]>([]);
  const [historySessions, setHistorySessions] = useState<RemoteHostSessionSummaryDto[]>([]);
  const [sessionTotal, setSessionTotal] = useState<number | null>(null);
  const [sessionNextCursor, setSessionNextCursor] = useState<string | null>(null);
  const [historySessionNextCursor, setHistorySessionNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ identity: string; sessionId: string | null }>({
    identity,
    sessionId: null,
  });
  const selectedSessionId = selection.identity === identity ? selection.sessionId : null;
  const [selectedSession, setSelectedSession] = useState<RemoteHostSessionSummaryDto | null>(null);
  const [pendingBySession, setPendingBySession] = useState<ReadonlyMap<string, RemoteHostPendingListDto>>(EMPTY_PENDING);
  const [runtime, setRuntime] = useState<RemoteHostRuntimeControlsDto | null>(null);
  const [context, setContext] = useState<RemoteHostSessionContextDto | null>(null);
  const [inputCapabilities, setInputCapabilities] =
    useState<RemoteHostSessionInputCapabilitiesDto | null>(null);
  const [summaries, setSummaries] = useState<RemoteHostSummaryListDto | null>(null);
  const [summaryLoadError, setSummaryLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [paginationBusy, setPaginationBusy] = useState(false);
  const [localRevision, setLocalRevision] = useState(0);
  const [listRefreshTick, setListRefreshTick] = useState(0);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);
  const navigation = useRef(new Map<string, string | null>());
  const identityRef = useRef(identity);
  const {
    busy, error, reset: resetBusiness, run: runBusiness, runTerminal: runTerminalBusiness, setError,
  } = useRemoteBusinessRunner(identityRef, setLocalRevision);
  const runtimeRef = useRef<RemoteHostRuntimeControlsDto | null>(null);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const paginationSequence = useRef(0);
  const listLoads = useRef(new Set<string>());
  const listRefreshPending = useRef(new Set<string>());
  const detailLoads = useRef(new Set<string>());
  const detailRefreshPending = useRef(new Set<string>());
  const intents = useRef(new RemoteUserIntentLedger());
  const planReviews = useRef(new RemotePlanReviewTransports()).current;
  const addressableIdentityKey = hosts.snapshot === null ? null : hosts.snapshot.states.map(
    (item) => remoteSourceIdentity(item.profileId, item.authoritativeCoreId, item.workerGeneration),
  ).sort().join('\u0000');
  const taskRecords = useRemoteTaskRecords({
    activeProfileId, capabilities, dataRevision, identity, selectedSessionId, usable });
  const eventRecords = useRemoteEventRecords({
    activeProfileId, capabilities, dataRevision, identity, selectedSessionId, usable });
  const hydratePending = useRemotePendingHydrator({
    identityRef, listSequence, setPendingBySession, setError,
  });

  useEffect(() => {
    if (addressableIdentityKey === null) return;
    const addressable = new Set(addressableIdentityKey ? addressableIdentityKey.split('\u0000') : []);
    intents.current.retainSources(addressable);
    planReviews.retainSources(addressable);
  }, [addressableIdentityKey, planReviews]);
  useEffect(() => {
    identityRef.current = identity;
    runtimeRef.current = null;
    listSequence.current += 1;
    detailSequence.current += 1;
    resetBusiness();
    paginationSequence.current += 1;
    setSelection({ identity, sessionId: navigation.current.get(identity) ?? null });
    setSessions([]);
    setHistorySessions([]);
    setSessionTotal(null);
    setSessionNextCursor(null);
    setHistorySessionNextCursor(null);
    setHistoryLoading(false);
    setHistoryLoadError(null);
    setSelectedSession(null);
    setPendingBySession(EMPTY_PENDING);
    setRuntime(null);
    setContext(null);
    setInputCapabilities(null);
    setSummaries(null);
    setSummaryLoadError(null);
    setPaginationBusy(false);
  }, [identity, resetBusiness]);

  useEffect(() => {
    if (!usable || !activeProfileId) {
      listSequence.current += 1;
      setLoading(false);
      return;
    }
    if (listLoads.current.has(identity)) {
      listRefreshPending.current.add(identity);
      return;
    }
    const sequence = ++listSequence.current;
    listLoads.current.add(identity);
    setLoading(true);
    setHistoryLoading(true);
    setHistoryLoadError(null);
    const load = async (): Promise<void> => {
      const current = (): boolean =>
        sequence === listSequence.current && identityRef.current === identity;
      const live = window.api.listRemoteHostSessions(remoteSessionPageRequest(activeProfileId,
        REMOTE_HOST_PAGE_LIMIT, { includeArchived: false })).then((page) => {
        if (!current()) return;
        setSessions(page.sessions); setSessionTotal(page.total); setSessionNextCursor(page.nextCursor);
        setPendingBySession((value) => {
          const activeIds = new Set(page.sessions.map((session) => session.id));
          return new Map([...value].filter(([sessionId]) => activeIds.has(sessionId)));
        });
        setError(null);
        if (capabilities.has('pending.read')) {
          hydratePending(activeProfileId, identity, sequence, page.sessions);
        }
      }).catch((reason: unknown) => {
        if (current()) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => { if (current()) setLoading(false); });
      const history = window.api.listRemoteHostSessions(remoteSessionPageRequest(activeProfileId,
        REMOTE_HOST_PAGE_LIMIT, { includeArchived: true })).then((page) => {
        if (!current()) return;
        setHistorySessions(page.sessions); setHistorySessionNextCursor(page.nextCursor);
        setHistoryLoadError(null);
      }).catch((reason: unknown) => {
        if (current()) setHistoryLoadError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => { if (current()) setHistoryLoading(false); });
      await Promise.allSettled([live, history]);
    };
    void load().finally(() => {
      listLoads.current.delete(identity);
      if (
        listRefreshPending.current.delete(identity) &&
        identityRef.current === identity
      ) setListRefreshTick((current) => current + 1);
    });
  }, [
    activeProfileId,
    capabilities,
    dataRevision,
    identity,
    hydratePending,
    listRefreshTick,
    localRevision,
    usable,
  ]);

  useEffect(() => {
    if (!usable || !activeProfileId || !selectedSessionId) {
      detailSequence.current += 1;
      setSelectedSession(null);
      setRuntime(null);
      setContext(null);
      setInputCapabilities(null);
      runtimeRef.current = null;
      setSummaries(null);
      setSummaryLoadError(null);
      return;
    }
    const loadKey = `${identity}\u0000${selectedSessionId}`;
    if (detailLoads.current.has(loadKey)) {
      detailRefreshPending.current.add(loadKey);
      return;
    }
    const sequence = ++detailSequence.current;
    detailLoads.current.add(loadKey);
    const target = { profileId: activeProfileId, sessionId: selectedSessionId };
    const requests = startRemoteSessionDetailLoad(target, capabilities);
    const load = async (): Promise<void> => {
      const nextSession = await requests.session;
      if (sequence !== detailSequence.current || identityRef.current !== identity) return;
      if (!nextSession) {
        navigation.current.set(identity, null);
        setSelection({ identity, sessionId: null });
        setSelectedSession(null);
        setRuntime(null);
        setContext(null);
        setInputCapabilities(null);
        runtimeRef.current = null;
        setSummaries(null);
        setSummaryLoadError(null);
        setPendingBySession((current) => {
          const next = new Map(current); next.delete(selectedSessionId); return next;
        });
        setError('远程 session 不存在或已删除。');
        return;
      }
      if (nextSession.id !== selectedSessionId) throw new Error('远程 session 身份不匹配。');
      setSelectedSession(nextSession);
      const {
        pending: pendingResult,
        runtime: runtimeResult,
        summary: summaryResult,
        context: contextResult,
        input: inputResult,
      } =
        await requests.optional;
      if (sequence !== detailSequence.current || identityRef.current !== identity) return;
      const optionalErrors: string[] = [];
      if (runtimeResult.status === 'fulfilled') {
        runtimeRef.current = runtimeResult.value;
        setRuntime(runtimeResult.value);
      }
      else {
        runtimeRef.current = null;
        setRuntime(null);
        optionalErrors.push(runtimeResult.reason instanceof Error
          ? runtimeResult.reason.message : String(runtimeResult.reason));
      }
      if (summaryResult.status === 'fulfilled') {
        setSummaries(summaryResult.value);
        setSummaryLoadError(null);
      } else {
        const message = summaryResult.reason instanceof Error
          ? summaryResult.reason.message : String(summaryResult.reason);
        setSummaryLoadError(message);
        optionalErrors.push(message);
      }
      if (contextResult.status === 'fulfilled') setContext(contextResult.value);
      else {
        setContext(null);
        optionalErrors.push(contextResult.reason instanceof Error
          ? contextResult.reason.message : String(contextResult.reason));
      }
      if (inputResult.status === 'fulfilled') setInputCapabilities(inputResult.value);
      else {
        setInputCapabilities(null);
        optionalErrors.push(inputResult.reason instanceof Error
          ? inputResult.reason.message : String(inputResult.reason));
      }
      if (pendingResult.status === 'fulfilled' && pendingResult.value) {
        const nextPending = pendingResult.value;
        setPendingBySession((current) => new Map(current).set(selectedSessionId, nextPending));
      } else if (pendingResult.status === 'rejected') {
        optionalErrors.push(pendingResult.reason instanceof Error
          ? pendingResult.reason.message : String(pendingResult.reason));
      }
      setError(optionalErrors[0] ?? null);
    };
    void load().catch((reason: unknown) => {
      if (sequence === detailSequence.current && identityRef.current === identity) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      detailLoads.current.delete(loadKey);
      if (
        detailRefreshPending.current.delete(loadKey) &&
        identityRef.current === identity
      ) setDetailRefreshTick((current) => current + 1);
    });
  }, [
    activeProfileId,
    capabilities,
    dataRevision,
    detailRefreshTick,
    identity,
    localRevision,
    selectedSessionId,
    usable,
  ]);

  const selectSession = useCallback((sessionId: string | null): void => {
    const currentIdentity = identityRef.current;
    detailSequence.current += 1;
    navigation.current.set(currentIdentity, sessionId);
    setSelection({ identity: currentIdentity, sessionId });
    setSelectedSession(null);
    setRuntime(null);
    setContext(null);
    setInputCapabilities(null);
    runtimeRef.current = null;
    setSummaries(null);
    setSummaryLoadError(null);
    setError(null);
  }, []);

  const runPagination = useCallback(async <T,>(
    request: () => Promise<T>,
    applyPage: (page: T) => void,
  ): Promise<void> => {
    const expectedIdentity = identityRef.current;
    const expectedListSequence = listSequence.current;
    const sequence = ++paginationSequence.current;
    setPaginationBusy(true);
    setError(null);
    try {
      const page = await request();
      if (
        identityRef.current !== expectedIdentity ||
        listSequence.current !== expectedListSequence ||
        paginationSequence.current !== sequence
      ) return;
      applyPage(page);
    } catch (reason) {
      if (
        identityRef.current === expectedIdentity &&
        paginationSequence.current === sequence
      ) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (
        identityRef.current === expectedIdentity &&
        paginationSequence.current === sequence
      ) setPaginationBusy(false);
    }
  }, []);

  const target = (): { profileId: string; sessionId: string } => {
    if (!activeProfileId || !selectedSessionId) throw new Error('请先选择远程 session。');
    return { profileId: activeProfileId, sessionId: selectedSessionId };
  };
  const requireCapability = (capability: string): void => {
    if (!capabilities.has(capability)) throw new Error('远程 Core 不支持此操作。');
  };
  const detailReaders = createRemoteDetailReaders({
    currentIdentity: () => identityRef.current,
    requireCapability,
    target,
  });
  const sessionActions = createRemoteSessionActions({
    activeProfileId,
    identityRef,
    intents: intents.current,
    requireCapability,
    runBusiness,
    runTerminalBusiness,
    runtimeRef,
    selectSession,
    setRuntime,
    target,
  });

  return {
    addressableIdentityKey,
    busy: busy || paginationBusy,
    capabilities,
    dataRevision,
    error: error ?? hosts.error,
    eventLoadError: selectedSession?.id === selectedSessionId ? eventRecords.error : null,
    events: selectedSession?.id === selectedSessionId ? eventRecords.value : null,
    historySessions,
    historyLoading,
    historyLoadError,
    hasMoreHistorySessions: historySessionNextCursor !== null,
    hasMoreSessions: sessionNextCursor !== null,
    identity,
    loading,
    pendingBySession,
    profile,
    recoveringWorker,
    runtime,
    context,
    inputCapabilities,
    summaryLoadError,
    summaries,
    taskLoadError: selectedSession?.id === selectedSessionId ? taskRecords.error : null,
    tasks: selectedSession?.id === selectedSessionId ? taskRecords.value : null,
    selectedPending: selectedSession?.id === selectedSessionId && selectedSessionId
      ? pendingBySession.get(selectedSessionId) ?? null : null,
    selectedSession,
    selectedSessionId,
    sessions,
    sessionTotal,
    state,
    usable,
    clearError: () => { setError(null); hosts.clearError(); },
    ...sessionActions,
    ...detailReaders,
    planReviewTransport: (presentation, agentId) => planReviews.get({
      activeProfileId, capabilities, dataRevision, identity,
      currentIdentity: () => identityRef.current,
    }, presentation, agentId),
    loadMoreHistorySessions: async () => {
      if (!activeProfileId || !historySessionNextCursor) return;
      await runPagination<RemoteHostSessionPageDto>(
        () => window.api.listRemoteHostSessions(remoteSessionPageRequest(activeProfileId,
          REMOTE_HOST_PAGE_LIMIT, { cursor: historySessionNextCursor, includeArchived: true })),
        (page) => {
          setHistorySessions((current) => appendUnique(current, page.sessions, (item) => item.id));
          setHistorySessionNextCursor(page.nextCursor);
        },
      );
    },
    loadMoreSessions: async () => {
      if (!activeProfileId || !sessionNextCursor) return;
      await runPagination(
        () => window.api.listRemoteHostSessions(remoteSessionPageRequest(activeProfileId,
          REMOTE_HOST_PAGE_LIMIT, { cursor: sessionNextCursor, includeArchived: false })),
        (page) => {
          setSessions((current) => appendUnique(current, page.sessions, (item) => item.id));
          setSessionTotal(page.total);
          setSessionNextCursor(page.nextCursor);
          if (capabilities.has('pending.read')) {
            hydratePending(activeProfileId, identityRef.current, listSequence.current, page.sessions);
          }
        },
      );
    },
    refresh: () => setLocalRevision((current) => current + 1),
    selectSession,
  };
}
