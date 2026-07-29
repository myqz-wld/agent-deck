import { useEffect } from 'react';
import { useIssuesStore } from '@renderer/stores/issues-store';

/**
 * The application owns one always-on issue event subscription. Events update bounded query
 * membership even while IssuesPanel is unmounted and are pinned while a list snapshot is in flight.
 */
export function useIssuesBridge(): void {
  const upsertIssue = useIssuesStore((s) => s.upsertIssue);
  const removeIssue = useIssuesStore((s) => s.removeIssue);

  useEffect(() => {
    const off = window.api.onIssueChanged((e) => {
      if (e.kind === 'hardDeleted') {
        removeIssue(e.issueId);
      } else if (e.issue) {
        upsertIssue(e.issue);
      }
    });
    return off;
  }, [upsertIssue, removeIssue]);
}
