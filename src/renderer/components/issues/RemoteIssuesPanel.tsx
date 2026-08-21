import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';

import type { IssueRecord } from '@shared/types';
import type {
  RemoteHostIssueDto,
  RemoteHostIssueMutationResultDto,
} from '@shared/remote-host';
import type { IssueFilters } from '@renderer/stores/issues-store';
import type {
  RemoteSessionCreateInput,
  RemoteSessionSourceView,
} from '@renderer/remote-host/source-types';
import {
  RemoteUserIntentLedger,
  remoteSessionCreateIntentPayload,
} from '@renderer/remote-host/remote-intent-ledger';
import { remoteMutationAuthority } from '@renderer/remote-host/remote-source-utils';
import { IssueDetail, type IssueDetailDataSource } from '../IssueDetail';
import { EmptyIssueDetail, IssueBoard } from './IssueBoard';
import { useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';

const REMOTE_ISSUE_LIMIT = 100;
const KEYWORD_DEBOUNCE_MS = 300;
const DEFAULT_FILTERS: IssueFilters = {
  statuses: ['open', 'in-progress'],
  showDeleted: false,
};

function issueRecord(issue: RemoteHostIssueDto): IssueRecord {
  return issue;
}

function issueListRecord(issue: RemoteHostIssueDto): IssueRecord {
  const record: IssueRecord = { ...issue };
  delete record.appendices;
  return record;
}

function matches(issue: IssueRecord, filters: IssueFilters): boolean {
  if (!filters.showDeleted && issue.deletedAt !== null) return false;
  if (filters.statuses?.length && !filters.statuses.includes(issue.status)) return false;
  if (filters.kinds?.length && !filters.kinds.includes(issue.kind)) return false;
  const keyword = filters.titleKeyword?.trim().toLowerCase();
  return !keyword || issue.title.toLowerCase().includes(keyword);
}

function ordered(issues: readonly IssueRecord[]): IssueRecord[] {
  return [...issues].sort((left, right) =>
    right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

export function RemoteIssuesPanel({
  active = true,
  source,
  onOpenSession,
  onPresentationReadyChange,
}: {
  active?: boolean;
  source: RemoteSessionSourceView;
  onOpenSession?(sessionId: string): void;
  onPresentationReadyChange?(ready: boolean): void;
}): JSX.Element {
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS);
  const [keywordInput, setKeywordInput] = useState('');
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const navigation = useRef(new Map<string, string | null>());
  const identityRef = useRef(source.identity);
  const sourceRef = useRef(source);
  const filtersRef = useRef(filters);
  const selectedIssueIdRef = useRef(selectedIssueId);
  const revisionRef = useRef<number | null>(null);
  const issuesRef = useRef<IssueRecord[]>([]);
  const listSequence = useRef(0);
  const listFlight = useRef<Promise<void> | null>(null);
  const queuedRefresh = useRef<number | null>(null);
  const requestListRef = useRef<(mode: 'replace' | 'append', generation: number) => void>(() => {});
  const detailSequence = useRef(0);
  const mutationSequence = useRef(0);
  const intents = useRef(new RemoteUserIntentLedger());

  filtersRef.current = filters;
  sourceRef.current = source;
  useEffect(() => { selectedIssueIdRef.current = selectedIssueId; }, [selectedIssueId]);
  useEffect(() => {
    const key = source.addressableIdentityKey;
    if (key === null || key === undefined) return;
    intents.current.retainSources(new Set(key ? key.split('\u0000') : []));
  }, [source.addressableIdentityKey]);

  useEffect(() => {
    identityRef.current = source.identity;
    listSequence.current += 1;
    listFlight.current = null;
    queuedRefresh.current = null;
    detailSequence.current += 1;
    mutationSequence.current += 1;
    revisionRef.current = null;
    issuesRef.current = [];
    const restored = navigation.current.get(source.identity) ?? null;
    selectedIssueIdRef.current = restored;
    setSelectedIssueId(restored);
    setSelectedIssue(null);
    setIssues([]);
    setTruncated(false);
    setListError(null);
    setInitialized(false);
    setLoading(true);
    setLoadingMore(false);
  }, [source.identity]);

  useEffect(() => {
    const titleKeyword = keywordInput.trim() || undefined;
    if (filtersRef.current.titleKeyword === titleKeyword) return;
    const timer = setTimeout(() => {
      setFilters((current) => current.titleKeyword === titleKeyword
        ? current
        : { ...current, titleKeyword });
    }, KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  requestListRef.current = (mode, generation) => {
    const current = sourceRef.current;
    const profileId = current.profile?.id;
    if (!current.usable || !profileId || !current.capabilities.has('issues')) return;
    if (listFlight.current) {
      if (mode === 'replace') queuedRefresh.current = generation;
      return;
    }
    const expectedIdentity = current.identity;
    const offset = mode === 'append' ? issuesRef.current.length : 0;
    const query = filtersRef.current;
    if (mode === 'append') setLoadingMore(true);
    else {
      setLoading(true);
      setListError(null);
    }
    let flight!: Promise<void>;
    flight = window.api.listRemoteHostIssues({
      profileId,
      statuses: query.statuses ?? [],
      kinds: query.kinds ?? [],
      titleKeyword: query.titleKeyword ?? null,
      includeDeleted: query.showDeleted ?? false,
      limit: REMOTE_ISSUE_LIMIT,
      offset,
    }).then((result) => {
      if (identityRef.current !== expectedIdentity || listSequence.current !== generation) return;
      if (revisionRef.current !== null && result.revision < revisionRef.current) return;
      revisionRef.current = result.revision;
      const rows = result.issues.map(issueListRecord);
      const next = mode === 'replace'
        ? ordered(rows)
        : ordered([...new Map(
          [...issuesRef.current, ...rows].map((issue) => [issue.id, issue]),
        ).values()]);
      issuesRef.current = next;
      setIssues(next);
      setTruncated(result.truncated);
      const currentId = selectedIssueIdRef.current;
      if (currentId) {
        const observed = next.find((issue) => issue.id === currentId);
        if (observed) setSelectedIssue(observed);
      }
    }).catch(() => {
      if (identityRef.current === expectedIdentity && listSequence.current === generation) {
        setListError(mode === 'append'
          ? '更多问题读取失败，请稍后重试。'
          : '问题列表读取失败，请稍后重试。');
      }
    }).finally(() => {
      if (listFlight.current === flight) listFlight.current = null;
      if (identityRef.current === expectedIdentity && listSequence.current === generation) {
        setInitialized(true);
        setLoading(false);
        setLoadingMore(false);
      }
      const queued = queuedRefresh.current;
      if (queued !== null && listFlight.current === null) {
        queuedRefresh.current = null;
        requestListRef.current('replace', queued);
      }
    });
    listFlight.current = flight;
  };

  useEffect(() => {
    const generation = ++listSequence.current;
    requestListRef.current('replace', generation);
  }, [
    filters.kinds,
    filters.showDeleted,
    filters.statuses,
    filters.titleKeyword,
    source.capabilities,
    source.identity,
    source.profile?.id,
    source.usable,
  ]);

  const observedRevision = useRef({
    identity: source.identity,
    revision: source.resourceRevisions.issues,
  });
  useEffect(() => {
    const observed = observedRevision.current;
    const revision = source.resourceRevisions.issues;
    observedRevision.current = { identity: source.identity, revision };
    if (observed.identity !== source.identity || observed.revision === revision) return;
    const timer = setTimeout(() => {
      const generation = ++listSequence.current;
      requestListRef.current('replace', generation);
    }, 750);
    return () => clearTimeout(timer);
  }, [source.identity, source.resourceRevisions.issues]);

  const showInitialLoading = useDelayedAsyncFallback(
    !initialized,
    `${source.identity}:issues-initial`,
  );
  const showRefreshProgress = useDelayedAsyncFallback(
    initialized && loading,
    `${source.identity}:issues-refresh`,
  );
  useLayoutEffect(() => {
    onPresentationReadyChange?.(initialized || showInitialLoading);
  }, [initialized, onPresentationReadyChange, showInitialLoading]);

  const selectIssue = (issueId: string | null): void => {
    detailSequence.current += 1;
    mutationSequence.current += 1;
    navigation.current.set(identityRef.current, issueId);
    selectedIssueIdRef.current = issueId;
    setSelectedIssueId(issueId);
    setSelectedIssue(issueId ? issues.find((issue) => issue.id === issueId) ?? null : null);
    setListError(null);
  };

  const mergeIssue = (issue: IssueRecord): void => {
    if (selectedIssueIdRef.current === issue.id) setSelectedIssue(issue);
    const without = issuesRef.current.filter((candidate) => candidate.id !== issue.id);
    const next = matches(issue, filtersRef.current) ? ordered([...without, issue]) : without;
    issuesRef.current = next;
    setIssues(next);
  };

  const applyMutationResult = (result: {
    issue: RemoteHostIssueDto;
    revision: number;
  }): IssueRecord => {
    if (revisionRef.current !== null && result.revision < revisionRef.current) {
      const current = issuesRef.current.find((issue) => issue.id === result.issue.id);
      if (!current) throw new Error('收到过期的问题响应，请刷新后重试。');
      return current;
    }
    revisionRef.current = result.revision;
    const next = issueRecord(result.issue);
    mergeIssue(next);
    return next;
  };

  const requireReadTarget = (): { profileId: string; identity: string } => {
    if (!source.usable || !source.profile || !source.capabilities.has('issues')) {
      throw new Error('当前远端版本暂不支持问题管理。');
    }
    if (identityRef.current !== source.identity) {
      throw new Error('问题数据源已切换，请重试。');
    }
    return {
      profileId: source.profile.id,
      identity: source.identity,
    };
  };

  const requireMutationTarget = (): {
    expectedAuthority: ReturnType<typeof remoteMutationAuthority>;
    profileId: string;
    identity: string;
    revision: number;
  } => {
    const target = requireReadTarget();
    if (revisionRef.current === null) throw new Error('问题列表已变化，请刷新后重试。');
    return {
      ...target,
      expectedAuthority: remoteMutationAuthority(source.state),
      revision: revisionRef.current,
    };
  };

  const loadIssue = async (issueId: string): Promise<IssueRecord | null> => {
    const target = requireReadTarget();
    const sequence = ++detailSequence.current;
    let result;
    try {
      result = await window.api.getRemoteHostIssue({ profileId: target.profileId, issueId });
    } catch {
      throw new Error('问题详情读取失败，请稍后重试。');
    }
    if (
      identityRef.current !== target.identity ||
      detailSequence.current !== sequence ||
      selectedIssueIdRef.current !== issueId
    ) throw new Error('问题数据源已切换，请重试。');
    if (revisionRef.current !== null && result.revision < revisionRef.current) {
      throw new Error('收到过期的问题详情，请刷新后重试。');
    }
    revisionRef.current = result.revision;
    if (!result.issue) return null;
    const next = issueRecord(result.issue);
    mergeIssue(next);
    return next;
  };

  const mutate = async (
    operation: 'update' | 'soft-delete' | 'undelete',
    issueId: string,
    patch?: Parameters<IssueDetailDataSource['update']>[1],
  ): Promise<IssueRecord> => {
    const target = requireMutationTarget();
    const sequence = ++mutationSequence.current;
    const payload = { issueId, ...(patch ? { patch } : {}) };
    let result: RemoteHostIssueMutationResultDto;
    try {
      result = await intents.current.run(
        target.identity,
        `issue-${operation}`,
        payload,
        (intentId): Promise<RemoteHostIssueMutationResultDto> => {
          const common = {
            profileId: target.profileId,
            issueId,
            expectedAuthority: target.expectedAuthority,
            expectedRevision: target.revision,
            intentId,
          };
          if (operation === 'update') {
            return window.api.updateRemoteHostIssue({ ...common, patch: patch ?? {} });
          }
          return operation === 'soft-delete'
            ? window.api.softDeleteRemoteHostIssue(common)
            : window.api.undeleteRemoteHostIssue(common);
        },
      );
    } catch {
      throw new Error('问题更新失败，请稍后重试。');
    }
    if (identityRef.current !== target.identity || mutationSequence.current !== sequence) {
      throw new Error('问题数据源已切换，请刷新后重试。');
    }
    return applyMutationResult(result);
  };

  const observedIssue = selectedIssueId
    ? selectedIssue ?? issues.find((issue) => issue.id === selectedIssueId) ?? null
    : null;
  const detailSource: IssueDetailDataSource = {
    identity: `${source.identity}\u0000issues`,
    observedIssue,
    load: loadIssue,
    update: (issueId, patch) => mutate('update', issueId, patch),
    softDelete: (issueId) => mutate('soft-delete', issueId),
    undelete: (issueId) => mutate('undelete', issueId),
    onUpdated: mergeIssue,
    ...(source.capabilities.has('session-console.create') &&
      source.capabilities.has('session-console.read')
      ? {
          resolution: {
            source,
            create: async (issue: IssueRecord, create: RemoteSessionCreateInput) => {
              const target = requireMutationTarget();
              const sequence = ++mutationSequence.current;
              const payload = {
                issueId: issue.id,
                issueUpdatedAt: issue.updatedAt,
                ...create,
              };
              const intentPayload = {
                issueId: issue.id,
                issueUpdatedAt: issue.updatedAt,
                create: await remoteSessionCreateIntentPayload(create),
              };
              if (identityRef.current !== target.identity) {
                throw new Error('问题数据源已切换，请刷新后重试。');
              }
              let result;
              try {
                result = await intents.current.run(
                  target.identity,
                  'issue-resolve-in-new-session',
                  intentPayload,
                  (intentId) => window.api.resolveRemoteHostIssueInNewSession({
                    ...payload,
                    profileId: target.profileId,
                    expectedAuthority: target.expectedAuthority,
                    expectedRevision: target.revision,
                    intentId,
                  }),
                );
              } catch {
                throw new Error('处理会话创建或关联失败，请稍后重试。');
              }
              if (identityRef.current !== target.identity || mutationSequence.current !== sequence) {
                throw new Error('问题数据源已切换，请刷新后重试。');
              }
              return applyMutationResult(result);
            },
          },
        }
      : {}),
  };

  if (!source.capabilities.has('issues')) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-deck-muted">
        当前远端版本暂不支持问题管理，请更新远端服务。
      </div>
    );
  }

  return (
    <IssueBoard
      filters={filters}
      issues={issues}
      keywordInput={keywordInput}
      listError={listError}
      loading={!initialized ? showInitialLoading : showRefreshProgress && issues.length === 0}
      deferred={!initialized && !showInitialLoading && issues.length === 0}
      refreshing={initialized && showRefreshProgress}
      loadingMore={loadingMore}
      selectedIssueId={selectedIssueId}
      truncated={truncated}
      onFiltersChange={setFilters}
      onKeywordChange={setKeywordInput}
      onSelectIssue={selectIssue}
      onLoadMore={truncated ? () => requestListRef.current('append', listSequence.current) : undefined}
      detail={active && selectedIssueId ? (
        <IssueDetail
          key={`${source.identity}:${selectedIssueId}`}
          issueId={selectedIssueId}
          source={detailSource}
          onClose={() => selectIssue(null)}
          onOpenSession={onOpenSession}
        />
      ) : <EmptyIssueDetail />}
    />
  );
}
