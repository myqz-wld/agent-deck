import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RemoteHostRuntimeControlsDto,
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
import {
  remoteMutationAuthority,
  remoteSourceIdentity,
  resolveRemoteSessionId,
} from './remote-source-utils';
import { useRemoteSourceContext } from './use-remote-source-context';
import { createRemoteDetailReaders } from './remote-detail-readers';
import { startRemoteSessionDetailLoad } from './remote-session-detail-load';
import { useRemoteTaskRecords } from './use-remote-task-records';
import { useRemoteEventRecords } from './use-remote-event-records';
import { RemotePlanReviewTransports } from './remote-plan-review-transports';
import { useRemoteBusinessRunner } from './use-remote-business-runner';
import { createRemoteSessionActions } from './remote-session-actions';
import { useRemotePresentationLists } from './use-remote-presentation-lists';

export function useRemoteSessionSource(hosts: RemoteHostSnapshotState): RemoteSessionSourceView {
  const {
    activeProfileId, capabilities, identity, profile, resourceRevisions,
    recoveringWorker, state, usable,
  } = useRemoteSourceContext(hosts);
  const detailRevision = resourceRevisions['session-detail'];
  const [selection, setSelection] = useState<{ identity: string; sessionId: string | null }>({
    identity,
    sessionId: null,
  });
  const selectedSessionId = selection.identity === identity ? selection.sessionId : null;
  const [selectedSession, setSelectedSession] = useState<RemoteHostSessionSummaryDto | null>(null);
  const [runtime, setRuntime] = useState<RemoteHostRuntimeControlsDto | null>(null);
  const [runtimeLoadError, setRuntimeLoadError] = useState<string | null>(null);
  const [context, setContext] = useState<RemoteHostSessionContextDto | null>(null);
  const [contextLoadError, setContextLoadError] = useState<string | null>(null);
  const [inputCapabilities, setInputCapabilities] =
    useState<RemoteHostSessionInputCapabilitiesDto | null>(null);
  const [inputLoadError, setInputLoadError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<RemoteHostSummaryListDto | null>(null);
  const [summaryLoadError, setSummaryLoadError] = useState<string | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);
  const navigation = useRef(new Map<string, string | null>());
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const renameAliasesRef = useRef(hosts.sessionRenamesBySource);
  renameAliasesRef.current = hosts.sessionRenamesBySource;
  const usableRef = useRef(usable);
  usableRef.current = usable;
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const {
    busy, error, reset: resetBusiness, run: runBusiness, runTerminal: runTerminalBusiness, setError,
  } = useRemoteBusinessRunner(identityRef, setLocalRevision);
  const runtimeRef = useRef<RemoteHostRuntimeControlsDto | null>(null);
  const detailSequence = useRef(0);
  const detailLoads = useRef(new Set<string>());
  const detailRefreshPending = useRef(new Set<string>());
  const intents = useRef(new RemoteUserIntentLedger());
  const planReviews = useRef(new RemotePlanReviewTransports()).current;
  const addressableIdentityKey = hosts.snapshot === null ? null : hosts.snapshot.states.map(
    (item) => remoteSourceIdentity(item.profileId, item.authoritativeCoreId, item.workerGeneration),
  ).sort().join('\u0000');
  const taskRecords = useRemoteTaskRecords({
    activeProfileId, capabilities, dataRevision: detailRevision,
    identity, selectedSessionId, usable });
  const eventRecords = useRemoteEventRecords({
    activeProfileId, capabilities, dataRevision: detailRevision,
    identity, selectedSessionId, usable });
  const lists = useRemotePresentationLists({
    activeProfileId,
    capabilities,
    identity,
    localRevision,
    resourceRevisions,
    usable,
  });

  useEffect(() => {
    if (addressableIdentityKey === null) return;
    const addressable = new Set(addressableIdentityKey ? addressableIdentityKey.split('\u0000') : []);
    intents.current.retainSources(addressable);
    planReviews.retainSources(addressable);
  }, [addressableIdentityKey, planReviews]);
  useEffect(() => {
    runtimeRef.current = null;
    detailSequence.current += 1;
    resetBusiness();
    setSelection({ identity, sessionId: navigation.current.get(identity) ?? null });
    setSelectedSession(null);
    setRuntime(null);
    setRuntimeLoadError(null);
    setContext(null);
    setContextLoadError(null);
    setInputCapabilities(null);
    setInputLoadError(null);
    setSummaries(null);
    setSummaryLoadError(null);
  }, [identity, resetBusiness]);

  useEffect(() => {
    if (!usable || !activeProfileId || !selectedSessionId) {
      detailSequence.current += 1;
      setSelectedSession(null);
      setRuntime(null);
      setRuntimeLoadError(null);
      setContext(null);
      setContextLoadError(null);
      setInputCapabilities(null);
      setInputLoadError(null);
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
        setRuntimeLoadError(null);
        setContext(null);
        setContextLoadError(null);
        setInputCapabilities(null);
        setInputLoadError(null);
        runtimeRef.current = null;
        setSummaries(null);
        setSummaryLoadError(null);
        lists.mergePending(selectedSessionId, null);
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
      if (runtimeResult.status === 'fulfilled') {
        runtimeRef.current = runtimeResult.value;
        setRuntime(runtimeResult.value);
        setRuntimeLoadError(null);
      }
      else {
        runtimeRef.current = null;
        setRuntime(null);
        setRuntimeLoadError('读取 Worker 运行时控制失败，请稍后重试。');
      }
      if (summaryResult.status === 'fulfilled') {
        setSummaries(summaryResult.value);
        setSummaryLoadError(null);
      } else {
        const message = '读取 Worker 会话总结失败，请稍后重试。';
        setSummaryLoadError(message);
      }
      if (contextResult.status === 'fulfilled') {
        setContext(contextResult.value);
        setContextLoadError(null);
      }
      else {
        setContext(null);
        setContextLoadError('读取 Worker 上下文窗口快照失败，请稍后重试。');
      }
      if (inputResult.status === 'fulfilled') {
        setInputCapabilities(inputResult.value);
        setInputLoadError(null);
      }
      else {
        setInputCapabilities(null);
        setInputLoadError('读取 Worker 活动回合输入能力失败；图片输入已保持禁用。');
      }
      if (pendingResult.status === 'fulfilled' && pendingResult.value) {
        const nextPending = pendingResult.value;
        lists.mergePending(selectedSessionId, nextPending);
      }
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
    detailRevision,
    detailRefreshTick,
    identity,
    localRevision,
    lists.mergePending,
    selectedSessionId,
    usable,
  ]);

  const selectSession = useCallback((sessionId: string | null): void => {
    const currentIdentity = identityRef.current;
    const resolvedSessionId = sessionId === null
      ? null
      : resolveRemoteSessionId(renameAliasesRef.current?.get(currentIdentity), sessionId);
    detailSequence.current += 1;
    navigation.current.set(currentIdentity, resolvedSessionId);
    setSelection({ identity: currentIdentity, sessionId: resolvedSessionId });
    setSelectedSession(null);
    setRuntime(null);
    setRuntimeLoadError(null);
    setContext(null);
    setContextLoadError(null);
    setInputCapabilities(null);
    setInputLoadError(null);
    runtimeRef.current = null;
    setSummaries(null);
    setSummaryLoadError(null);
    setError(null);
  }, []);
  const renamedSelectedSessionId = selectedSessionId === null
    ? null
    : resolveRemoteSessionId(hosts.sessionRenamesBySource?.get(identity), selectedSessionId);
  useEffect(() => {
    if (renamedSelectedSessionId !== selectedSessionId) selectSession(renamedSelectedSessionId);
  }, [renamedSelectedSessionId, selectSession, selectedSessionId]);

  const target = (): { profileId: string; sessionId: string } => {
    if (!activeProfileId || !selectedSessionId) throw new Error('请先选择远程 session。');
    return { profileId: activeProfileId, sessionId: selectedSessionId };
  };
  const actionIdentity = identity;
  const requireCapability = (capability: string): void => {
    if (identityRef.current !== actionIdentity) throw new Error('数据源已切换，请重试。');
    if (!usableRef.current) throw new Error('远程数据源尚未连接。');
    if (!capabilitiesRef.current.has(capability)) throw new Error('远程 Core 不支持此操作。');
  };
  const detailReaders = createRemoteDetailReaders({
    currentIdentity: () => identityRef.current,
    requireCapability,
    target,
  });
  const sessionActions = createRemoteSessionActions({
    activeProfileId,
    expectedAuthority: remoteMutationAuthority(state),
    identityRef,
    intents: intents.current,
    requireCapability,
    runBusiness,
    runTerminalBusiness,
    runtimeRef,
    selectSession,
    setRuntime,
    sourceIdentity: identity,
    target,
  });

  return {
    addressableIdentityKey,
    busy: usable && busy,
    capabilities,
    dataRevision: detailRevision,
    resourceRevisions,
    error: error ?? lists.error ?? hosts.error,
    eventLoadError: usable && selectedSession?.id === selectedSessionId
      ? eventRecords.error : null,
    events: usable && selectedSession?.id === selectedSessionId ? eventRecords.value : null,
    historySessions: lists.historySessions,
    historyLoading: lists.historyLoading,
    historyPaginationBusy: lists.historyPaginationBusy,
    historyLoadError: lists.historyLoadError,
    historyQuery: lists.historyQuery,
    historyArchivedOnly: lists.historyArchivedOnly,
    hasMoreHistorySessions: lists.hasMoreHistorySessions,
    hasMoreSessions: lists.hasMoreSessions,
    identity,
    loading: lists.loading,
    livePaginationBusy: lists.livePaginationBusy,
    pendingBuckets: lists.pendingBuckets,
    pendingBySession: lists.pendingBySession,
    pendingLoading: lists.pendingLoading,
    pendingPaginationBusy: lists.pendingPaginationBusy,
    pendingLoadError: lists.pendingLoadError,
    pendingTotal: lists.pendingTotal,
    pendingScanTruncated: lists.pendingScanTruncated,
    hasMorePending: lists.hasMorePending,
    presentationCounts: lists.counts,
    profile,
    recoveringWorker,
    runtime: usable ? runtime : null,
    runtimeLoadError: usable ? runtimeLoadError : null,
    context: usable ? context : null,
    contextLoadError: usable ? contextLoadError : null,
    inputCapabilities: usable ? inputCapabilities : null,
    inputLoadError: usable ? inputLoadError : null,
    summaryLoadError: usable ? summaryLoadError : null,
    summaries: usable ? summaries : null,
    taskLoadError: usable && selectedSession?.id === selectedSessionId
      ? taskRecords.error : null,
    tasks: usable && selectedSession?.id === selectedSessionId ? taskRecords.value : null,
    selectedPending: usable && selectedSession?.id === selectedSessionId && selectedSessionId
      ? lists.pendingBySession.get(selectedSessionId) ?? null : null,
    selectedSession: usable ? selectedSession : null,
    selectedSessionId,
    sessions: lists.sessions,
    sessionTotal: lists.total,
    state,
    usable,
    clearError: () => { setError(null); lists.clearErrors(); hosts.clearError(); },
    ...sessionActions,
    ...detailReaders,
    planReviewTransport: (presentation, agentId) => planReviews.get({
      activeProfileId, capabilities, dataRevision: detailRevision, identity,
      currentIdentity: () => identityRef.current,
      expectedAuthority: remoteMutationAuthority(state),
      usable,
    }, presentation, agentId),
    loadMoreHistorySessions: lists.loadMoreHistorySessions,
    loadMoreSessions: lists.loadMoreSessions,
    loadMorePending: lists.loadMorePending,
    setHistoryQuery: lists.setHistoryQuery,
    setHistoryArchivedOnly: lists.setHistoryArchivedOnly,
    refresh: () => setLocalRevision((current) => current + 1),
    selectSession,
  };
}
