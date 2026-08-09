/** Bounded issue query list; the application-level bridge owns live event subscription. */

import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  useIssuesStore,
  selectFilteredIssues,
} from '../stores/issues-store';
import { IssueDetail } from './IssueDetail';
import { EmptyIssueDetail, IssueBoard } from './issues/IssueBoard';

const KEYWORD_DEBOUNCE_MS = 300;

export function IssuesPanel({ onOpenSession }: { onOpenSession?: (sid: string) => void }): JSX.Element {
  const issues = useIssuesStore((s) => s.issues);
  const queryIssueIds = useIssuesStore((s) => s.queryIssueIds);
  const filters = useIssuesStore((s) => s.filters);
  const selectedIssueId = useIssuesStore((s) => s.selectedIssueId);
  const beginListRequest = useIssuesStore((s) => s.beginListRequest);
  const mergeIssuesFromList = useIssuesStore((s) => s.mergeIssuesFromList);
  const cancelListRequest = useIssuesStore((s) => s.cancelListRequest);
  const setFilters = useIssuesStore((s) => s.setFilters);
  const selectIssue = useIssuesStore((s) => s.selectIssue);

  const [keywordInput, setKeywordInput] = useState(filters.titleKeyword ?? '');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listReloadNonce, setListReloadNonce] = useState(0);

  // Query membership, rather than the entity cache, is the list boundary.
  const filteredList = useMemo(
    () => selectFilteredIssues({ issues, queryIssueIds, filters }),
    [issues, queryIssueIds, filters],
  );

  // The functional updater preserves filter changes made during the keyword debounce.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((prev) => ({ ...prev, titleKeyword: keywordInput || undefined }));
    }, KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordInput]);

  // 初始 + filters 变 重拉 list
  useEffect(() => {
    let cancelled = false;
    const requestId = beginListRequest(500);
    setLoading(true);
    setListError(null);
    void window.api
      .issuesList({
        statuses: filters.statuses,
        kinds: filters.kinds,
        titleKeyword: filters.titleKeyword,
        includeDeleted: filters.showDeleted,
        limit: 500,
      })
      .then((list) => {
        if (cancelled) return;
        const outcome = mergeIssuesFromList(requestId, list);
        if (outcome === 'retry') {
          setListReloadNonce((value) => value + 1);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        cancelListRequest(requestId);
        setListError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      cancelListRequest(requestId);
    };
  }, [
    filters.statuses,
    filters.kinds,
    filters.titleKeyword,
    filters.showDeleted,
    listReloadNonce,
    beginListRequest,
    mergeIssuesFromList,
    cancelListRequest,
  ]);

  return (
    <IssueBoard
      filters={filters}
      issues={filteredList}
      keywordInput={keywordInput}
      listError={listError}
      loading={loading}
      selectedIssueId={selectedIssueId}
      onFiltersChange={setFilters}
      onKeywordChange={setKeywordInput}
      onSelectIssue={selectIssue}
      detail={selectedIssueId ? (
        // The key resets the per-issue edit baseline before another issue can receive the draft.
        <IssueDetail
          key={selectedIssueId}
          issueId={selectedIssueId}
          onClose={() => selectIssue(null)}
          onOpenSession={onOpenSession}
        />
      ) : <EmptyIssueDetail />}
    />
  );
}
