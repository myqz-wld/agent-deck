import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  REMOTE_HOST_PAGE_LIMIT,
  remoteHistoryRequest,
  remotePageRequest,
  remoteSessionPageRequest,
} from '@shared/remote-host';
import type {
  RemoteHostHistoryPageDto,
  RemoteHostJsonObject,
  RemoteHostPendingListDto,
  RemoteHostProjectDto,
  RemoteHostProjectPageDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostSessionPageDto,
  RemoteHostSessionSummaryDto,
} from '@shared/remote-host';
import { isRecoverableRelayWorkerOffline } from '@shared/remote-host';

import type { RemoteSessionSourceView } from './source-types';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import { RemoteUserIntentLedger } from './remote-intent-ledger';
import {
  appendUnique,
  loadPendingRows,
  remoteSourceIdentity,
} from './remote-source-utils';

const EMPTY_PENDING = new Map<string, RemoteHostPendingListDto>();
const PENDING_CONCURRENCY = 4;

export function useRemoteSessionSource(hosts: RemoteHostSnapshotState): RemoteSessionSourceView {
  const snapshot = hosts.snapshot;
  const activeProfileId = snapshot?.sourceMode === 'remote'
    ? snapshot.selectedRemoteProfileId
    : null;
  const profile = snapshot?.profiles.find((item) => item.id === activeProfileId) ?? null;
  const state = snapshot?.states.find((item) => item.profileId === activeProfileId) ?? null;
  const identity = activeProfileId
    ? remoteSourceIdentity(activeProfileId, state?.authoritativeCoreId ?? null, state?.workerGeneration ?? null)
    : 'local';
  const recoveringWorker = isRecoverableRelayWorkerOffline(state);
  const dataRevision = activeProfileId
    ? Math.max(hosts.dataRevisionByProfile.get('*') ?? 0,
        hosts.dataRevisionByProfile.get(activeProfileId) ?? 0)
    : 0;
  const usable = Boolean(
    activeProfileId &&
    profile?.scope === 'remote' &&
    (state?.status === 'connected' || state?.status === 'reconnecting' || recoveringWorker),
  );
  const capabilityKey = (state?.capabilities ?? []).join('\u0000');
  // HostHello capabilities are unique; the joined key ignores snapshot clones.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const capabilities = useMemo(
    () => new Set(state?.capabilities ?? []),
    [capabilityKey],
  );
  const [sessions, setSessions] = useState<RemoteHostSessionSummaryDto[]>([]);
  const [historySessions, setHistorySessions] = useState<RemoteHostSessionSummaryDto[]>([]);
  const [projects, setProjects] = useState<RemoteHostProjectDto[]>([]);
  const [sessionTotal, setSessionTotal] = useState<number | null>(null);
  const [sessionNextCursor, setSessionNextCursor] = useState<string | null>(null);
  const [historySessionNextCursor, setHistorySessionNextCursor] = useState<string | null>(null);
  const [projectNextCursor, setProjectNextCursor] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ identity: string; sessionId: string | null }>({
    identity,
    sessionId: null,
  });
  const selectedSessionId = selection.identity === identity ? selection.sessionId : null;
  const [selectedSession, setSelectedSession] = useState<RemoteHostSessionSummaryDto | null>(null);
  const [history, setHistory] = useState<RemoteHostHistoryPageDto | null>(null);
  const [pendingBySession, setPendingBySession] = useState<ReadonlyMap<string, RemoteHostPendingListDto>>(EMPTY_PENDING);
  const [runtime, setRuntime] = useState<RemoteHostRuntimeControlsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paginationBusy, setPaginationBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const [listRefreshTick, setListRefreshTick] = useState(0);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);
  const navigation = useRef(new Map<string, string | null>());
  const identityRef = useRef(identity);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const businessSequence = useRef(0);
  const paginationSequence = useRef(0);
  const listLoads = useRef(new Set<string>());
  const listRefreshPending = useRef(new Set<string>());
  const detailLoads = useRef(new Set<string>());
  const detailRefreshPending = useRef(new Set<string>());
  const intents = useRef(new RemoteUserIntentLedger());

  const hydratePending = useCallback((
    profileId: string,
    expectedIdentity: string,
    expectedListSequence: number,
    rows: readonly RemoteHostSessionSummaryDto[],
  ): void => {
    void loadPendingRows(profileId, rows, PENDING_CONCURRENCY,
      window.api.listRemoteHostPending).then((results) => {
      if (identityRef.current !== expectedIdentity ||
          listSequence.current !== expectedListSequence) return;
      setPendingBySession((current) => {
        const next = new Map(current);
        for (const result of results) {
          if ('value' in result) next.set(result.id, result.value);
        }
        return next;
      });
      const failed = results.find((result) => 'reason' in result);
      if (failed && 'reason' in failed) {
        setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
      }
    });
  }, []);

  useEffect(() => {
    identityRef.current = identity;
    listSequence.current += 1;
    detailSequence.current += 1;
    businessSequence.current += 1;
    paginationSequence.current += 1;
    setSelection({ identity, sessionId: navigation.current.get(identity) ?? null });
    setSessions([]);
    setHistorySessions([]);
    setProjects([]);
    setSessionTotal(null);
    setSessionNextCursor(null);
    setHistorySessionNextCursor(null);
    setProjectNextCursor(null);
    setSelectedSession(null);
    setHistory(null);
    setPendingBySession(EMPTY_PENDING);
    setRuntime(null);
    setBusy(false);
    setPaginationBusy(false);
    setError(null);
  }, [identity]);

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
    const load = async (): Promise<void> => {
      const [livePage, archivedPage, projectPage] = await Promise.all([
        window.api.listRemoteHostSessions(remoteSessionPageRequest(activeProfileId,
          REMOTE_HOST_PAGE_LIMIT, { includeArchived: false })),
        window.api.listRemoteHostSessions(remoteSessionPageRequest(activeProfileId,
          REMOTE_HOST_PAGE_LIMIT, { includeArchived: true })),
        capabilities.has('projects.read')
          ? window.api.listRemoteHostProjects(remotePageRequest(activeProfileId, REMOTE_HOST_PAGE_LIMIT))
          : Promise.resolve({ projects: [], nextCursor: null, total: 0, revision: 0 }),
      ]);
      if (sequence !== listSequence.current || identityRef.current !== identity) return;
      setSessions(livePage.sessions);
      setHistorySessions(archivedPage.sessions);
      setProjects(projectPage.projects);
      setSessionTotal(livePage.total);
      setSessionNextCursor(livePage.nextCursor);
      setHistorySessionNextCursor(archivedPage.nextCursor);
      setProjectNextCursor(projectPage.nextCursor);
      setPendingBySession((current) => {
        const activeIds = new Set(livePage.sessions.map((session) => session.id));
        return new Map([...current].filter(([sessionId]) => activeIds.has(sessionId)));
      });
      setError(null);
      if (capabilities.has('pending.read')) {
        hydratePending(activeProfileId, identity, sequence, livePage.sessions);
      }
    };
    void load().catch((reason: unknown) => {
      if (sequence === listSequence.current && identityRef.current === identity) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      listLoads.current.delete(identity);
      if (sequence === listSequence.current && identityRef.current === identity) setLoading(false);
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
      setHistory(null);
      setRuntime(null);
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
    const load = async (): Promise<void> => {
      const [nextSession, nextHistory, nextPending, nextRuntime] = await Promise.all([
        window.api.getRemoteHostSession(target),
        capabilities.has('sessions.history')
          ? window.api.listRemoteHostHistory(remoteHistoryRequest(
              activeProfileId,
              selectedSessionId,
              REMOTE_HOST_PAGE_LIMIT,
            ))
          : Promise.resolve(null),
        capabilities.has('pending.read')
          ? window.api.listRemoteHostPending(target)
          : Promise.resolve(null),
        capabilities.has('sessions.runtime.read')
          ? window.api.getRemoteHostRuntime(target)
          : Promise.resolve(null),
      ]);
      if (sequence !== detailSequence.current || identityRef.current !== identity) return;
      if (!nextSession) {
        navigation.current.set(identity, null);
        setSelection({ identity, sessionId: null });
        setSelectedSession(null);
        setHistory(null);
        setRuntime(null);
        setPendingBySession((current) => {
          const next = new Map(current); next.delete(selectedSessionId); return next;
        });
        setError('远程 session 不存在或已删除。');
        return;
      }
      if (nextSession.id !== selectedSessionId) throw new Error('远程 session 身份不匹配。');
      setSelectedSession(nextSession);
      setHistory(nextHistory);
      setRuntime(nextRuntime);
      if (nextPending) {
        setPendingBySession((current) => new Map(current).set(selectedSessionId, nextPending));
      }
      setError(null);
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
    businessSequence.current += 1;
    navigation.current.set(currentIdentity, sessionId);
    setSelection({ identity: currentIdentity, sessionId });
    setSelectedSession(null);
    setHistory(null);
    setRuntime(null);
    setError(null);
  }, []);

  const runBusiness = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const expectedIdentity = identityRef.current;
    const sequence = ++businessSequence.current;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (
        identityRef.current !== expectedIdentity ||
        sequence !== businessSequence.current
      ) throw new Error('数据源已切换，请重试。');
      setLocalRevision((current) => current + 1);
      return result;
    } catch (reason) {
      if (
        identityRef.current === expectedIdentity &&
        sequence === businessSequence.current
      ) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      throw reason;
    } finally {
      if (
        identityRef.current === expectedIdentity &&
        sequence === businessSequence.current
      ) setBusy(false);
    }
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

  return {
    busy: busy || paginationBusy,
    capabilities,
    error: error ?? hosts.error,
    history,
    historySessions,
    hasMoreHistorySessions: historySessionNextCursor !== null,
    hasMoreProjects: projectNextCursor !== null,
    hasMoreSessions: sessionNextCursor !== null,
    identity,
    loading,
    pendingBySession,
    profile,
    projects,
    recoveringWorker,
    runtime,
    selectedPending: selectedSession?.id === selectedSessionId && selectedSessionId
      ? pendingBySession.get(selectedSessionId) ?? null : null,
    selectedSession,
    selectedSessionId,
    sessions,
    sessionTotal,
    state,
    usable,
    clearError: () => { setError(null); hosts.clearError(); },
    createSession: async (adapterId, projectRef) => {
      const created = await runBusiness(async () => {
        requireCapability('session-console.create');
        if (!activeProfileId) throw new Error('请选择远程配置。');
        return intents.current.run(identityRef.current, 'create', { adapterId, projectRef, options: {} }, (intentId) =>
          window.api.createRemoteHostSession({
            profileId: activeProfileId,
            adapterId,
            projectRef,
            options: {},
            intentId,
          }));
      });
      selectSession(created.sessionId);
    },
    interrupt: () => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = target();
      await intents.current.run(identityRef.current, 'interrupt', request, (intentId) =>
        window.api.interruptRemoteHostSession({ ...request, intentId }));
    }),
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
    loadMoreProjects: async () => {
      if (!activeProfileId || !projectNextCursor) return;
      await runPagination<RemoteHostProjectPageDto>(
        () => window.api.listRemoteHostProjects(remotePageRequest(activeProfileId,
          REMOTE_HOST_PAGE_LIMIT, projectNextCursor)),
        (page) => {
          setProjects((current) => appendUnique(
            current,
            page.projects,
            (item) => item.projectId,
          ));
          setProjectNextCursor(page.nextCursor);
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
    respondPending: (presentation, action, value) => runBusiness(async () => {
      requireCapability('pending.respond');
      if (!activeProfileId || presentation.sourceIdentity !== identityRef.current) {
        throw new Error('待处理展示已切换，请刷新后重试。');
      }
      const request = presentation.request;
      const payload = {
        profileId: activeProfileId,
        sessionId: request.sessionId,
        requestId: request.id,
        action,
        ...(value === undefined ? {} : { value }),
        expectedRevision: presentation.revision,
      };
      await intents.current.run(identityRef.current, 'pending', payload, (intentId) =>
        window.api.respondRemoteHostPending({ ...payload, intentId }));
    }),
    selectSession,
    send: (text) => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = { ...target(), text };
      await intents.current.run(identityRef.current, 'send', request, (intentId) =>
        window.api.sendRemoteHostMessage({ ...request, intentId }));
    }),
    steer: (text) => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = { ...target(), text };
      await intents.current.run(identityRef.current, 'steer', request, (intentId) =>
        window.api.steerRemoteHostSession({ ...request, intentId }));
    }),
    updateRuntime: (patch: RemoteHostJsonObject) => runBusiness(async () => {
      requireCapability('sessions.runtime.write');
      if (!runtime) throw new Error('运行时控制已变化，请刷新后重试。');
      const request = {
        ...target(),
        patch,
        expectedRevision: runtime.revision,
      };
      await intents.current.run(identityRef.current, 'runtime', request, (intentId) =>
        window.api.updateRemoteHostRuntime({ ...request, intentId }));
    }),
  };
}
