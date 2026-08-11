import { useEffect, useRef, useState, type JSX } from 'react';

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
import { IssueDetail, type IssueDetailDataSource } from '../IssueDetail';
import { EmptyIssueDetail, IssueBoard } from './IssueBoard';

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
  source,
  onOpenSession,
}: {
  source: RemoteSessionSourceView;
  onOpenSession?(sessionId: string): void;
}): JSX.Element {
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS);
  const [keywordInput, setKeywordInput] = useState('');
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const navigation = useRef(new Map<string, string | null>());
  const identityRef = useRef(source.identity);
  const filtersRef = useRef(filters);
  const selectedIssueIdRef = useRef(selectedIssueId);
  const revisionRef = useRef<number | null>(null);
  const issuesRef = useRef<IssueRecord[]>([]);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const mutationSequence = useRef(0);
  const intents = useRef(new RemoteUserIntentLedger());

  useEffect(() => { filtersRef.current = filters; }, [filters]);
  useEffect(() => { selectedIssueIdRef.current = selectedIssueId; }, [selectedIssueId]);
  useEffect(() => {
    const key = source.addressableIdentityKey;
    if (key === null || key === undefined) return;
    intents.current.retainSources(new Set(key ? key.split('\u0000') : []));
  }, [source.addressableIdentityKey]);

  useEffect(() => {
    identityRef.current = source.identity;
    listSequence.current += 1;
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
    setLoading(false);
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

  useEffect(() => {
    const profileId = source.profile?.id;
    if (!source.usable || !profileId || !source.capabilities.has('issues')) {
      listSequence.current += 1;
      setLoading(false);
      return;
    }
    const expectedIdentity = source.identity;
    const sequence = ++listSequence.current;
    setLoading(true);
    setListError(null);
    void window.api.listRemoteHostIssues({
      profileId,
      statuses: filters.statuses ?? [],
      kinds: filters.kinds ?? [],
      titleKeyword: filters.titleKeyword ?? null,
      includeDeleted: filters.showDeleted ?? false,
      limit: REMOTE_ISSUE_LIMIT,
      offset: 0,
    }).then((result) => {
      if (identityRef.current !== expectedIdentity || listSequence.current !== sequence) return;
      if (revisionRef.current !== null && result.revision < revisionRef.current) return;
      revisionRef.current = result.revision;
      const next = ordered(result.issues.map(issueListRecord));
      issuesRef.current = next;
      setIssues(next);
      setTruncated(result.truncated);
      const currentId = selectedIssueIdRef.current;
      if (currentId) {
        const observed = next.find((issue) => issue.id === currentId);
        if (observed) setSelectedIssue(observed);
      }
    }).catch((reason: unknown) => {
      if (identityRef.current === expectedIdentity && listSequence.current === sequence) {
        setListError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (identityRef.current === expectedIdentity && listSequence.current === sequence) {
        setLoading(false);
      }
    });
  }, [
    filters,
    source.capabilities,
    source.dataRevision,
    source.identity,
    source.profile?.id,
    source.usable,
  ]);

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
      throw new Error('远程 Core 不支持问题管理。');
    }
    if (identityRef.current !== source.identity) {
      throw new Error('问题数据源已切换，请重试。');
    }
    return {
      profileId: source.profile.id,
      identity: source.identity,
    };
  };

  const requireMutationTarget = (): { profileId: string; identity: string; revision: number } => {
    const target = requireReadTarget();
    if (revisionRef.current === null) throw new Error('问题列表已变化，请刷新后重试。');
    return { ...target, revision: revisionRef.current };
  };

  const loadIssue = async (issueId: string): Promise<IssueRecord | null> => {
    const target = requireReadTarget();
    const sequence = ++detailSequence.current;
    const result = await window.api.getRemoteHostIssue({
      profileId: target.profileId,
      issueId,
    });
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
    const result = await intents.current.run(
      target.identity,
      `issue-${operation}`,
      payload,
      (intentId): Promise<RemoteHostIssueMutationResultDto> => {
        const common = {
          profileId: target.profileId,
          issueId,
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
              const result = await intents.current.run(
                target.identity,
                'issue-resolve-in-new-session',
                intentPayload,
                (intentId) => window.api.resolveRemoteHostIssueInNewSession({
                  ...payload,
                  profileId: target.profileId,
                  expectedRevision: target.revision,
                  intentId,
                }),
              );
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
        当前远程 Core 未提供问题管理能力，不会回退读取 Local 数据。
      </div>
    );
  }

  return (
    <IssueBoard
      filters={filters}
      issues={issues}
      keywordInput={keywordInput}
      listError={listError}
      loading={loading}
      selectedIssueId={selectedIssueId}
      truncated={truncated}
      onFiltersChange={setFilters}
      onKeywordChange={setKeywordInput}
      onSelectIssue={selectIssue}
      detail={selectedIssueId ? (
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
