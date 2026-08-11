import { useCallback, useEffect, useRef, useState } from 'react';
import { REMOTE_HOST_PAGE_LIMIT, remoteSessionPageRequest } from '@shared/remote-host';
import type {
  RemoteHostJsonObject,
  RemoteHostPendingListDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostSessionPageDto,
  RemoteHostSessionSummaryDto,
  RemoteHostSummaryListDto,
} from '@shared/remote-host';
import type { RemoteSessionSourceView } from './source-types';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import {
  RemoteUserIntentLedger,
  remoteSessionCreateIntentPayload,
  remoteAttachmentIntentPayload,
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
import { pendingPresentationBindingDigest } from './remote-pending-presentation';
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
  const [summaries, setSummaries] = useState<RemoteHostSummaryListDto | null>(null);
  const [summaryLoadError, setSummaryLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [paginationBusy, setPaginationBusy] = useState(false);
  const [localRevision, setLocalRevision] = useState(0);
  const [listRefreshTick, setListRefreshTick] = useState(0);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);
  const navigation = useRef(new Map<string, string | null>());
  const identityRef = useRef(identity);
  const { busy, error, reset: resetBusiness, run: runBusiness, setError } =
    useRemoteBusinessRunner(identityRef, setLocalRevision);
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
      const { pending: pendingResult, runtime: runtimeResult, summary: summaryResult } =
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
    createSession: async (input) => {
      const created = await runBusiness(async () => {
        requireCapability('session-console.create');
        if (!activeProfileId) throw new Error('请选择远程配置。');
        const intentPayload = await remoteSessionCreateIntentPayload(input);
        return intents.current.run(
          identityRef.current,
          'create',
          intentPayload,
          (intentId) =>
          window.api.createRemoteHostSession({
            profileId: activeProfileId,
            ...input,
            intentId,
          }),
        );
      });
      selectSession(created.sessionId);
      return created.sessionId;
    },
    getSessionCapabilities: async (request) => {
      requireCapability('session-console.read');
      if (!activeProfileId) throw new Error('请选择远程配置。');
      const expectedIdentity = identityRef.current;
      const result = await window.api.getRemoteHostSessionCapabilities({
        profileId: activeProfileId,
        ...request,
      });
      if (identityRef.current !== expectedIdentity) {
        throw new Error('数据源已切换，请重试。');
      }
      return result;
    },
    listWorkspaceDirectories: async (directory) => {
      requireCapability('session-console.read');
      if (!activeProfileId) throw new Error('请选择远程配置。');
      const expectedIdentity = identityRef.current;
      const result = await window.api.listRemoteHostWorkspaceDirectories({
        profileId: activeProfileId,
        directory,
      });
      if (identityRef.current !== expectedIdentity) {
        throw new Error('数据源已切换，请重试。');
      }
      return result;
    },
    ...detailReaders,
    planReviewTransport: (presentation, agentId) => planReviews.get({
      activeProfileId, capabilities, dataRevision, identity,
      currentIdentity: () => identityRef.current,
    }, presentation, agentId),
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
      const expectedPresentationDigest = await pendingPresentationBindingDigest(request);
      const payload = {
        profileId: activeProfileId,
        sessionId: request.sessionId,
        requestId: request.id,
        action,
        ...(value === undefined ? {} : { value }),
        expectedRevision: presentation.revision,
        expectedPresentationDigest,
      };
      await intents.current.run(identityRef.current, 'pending', payload, (intentId) =>
        window.api.respondRemoteHostPending({ ...payload, intentId }));
    }),
    selectSession,
    send: (text, attachments = []) => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = {
        ...target(),
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      const intentPayload = await remoteAttachmentIntentPayload(text, attachments);
      await intents.current.run(identityRef.current, 'send', {
        target: target(),
        message: intentPayload,
      }, (intentId) => window.api.sendRemoteHostMessage({ ...request, intentId }));
    }),
    steer: (text) => runBusiness(async () => {
      requireCapability('sessions.write');
      const request = { ...target(), text };
      await intents.current.run(identityRef.current, 'steer', request, (intentId) =>
        window.api.steerRemoteHostSession({ ...request, intentId }));
    }),
    updateRuntime: async (patch: RemoteHostJsonObject) => {
      const result = await runBusiness(async () => {
        requireCapability('sessions.runtime.write');
        const controls = runtimeRef.current;
        if (!controls) throw new Error('运行时控制已变化，请刷新后重试。');
        const request = {
          ...target(),
          patch,
          expectedRevision: controls.revision,
        };
        return intents.current.run(identityRef.current, 'runtime', request, (intentId) =>
          window.api.updateRemoteHostRuntime({ ...request, intentId }));
      });
      if (result.replacementSessionId) {
        selectSession(result.replacementSessionId);
        return;
      }
      runtimeRef.current = result.controls;
      setRuntime(result.controls);
    },
  };
}
