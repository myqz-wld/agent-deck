import { useEffect } from 'react';
import { useIssuesStore } from '@renderer/stores/issues-store';

/**
 * The application owns one always-on issue event subscription. Events update bounded query
 * membership even while IssuesPanel is unmounted and are pinned while a list snapshot is in flight.
 */
export function useIssuesBridge(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const off = window.api.onIssueChanged((e) => {
      if (e.kind === 'hardDeleted') {
        useIssuesStore.getState().removeIssue(e.issueId);
      } else if (e.issue) {
        useIssuesStore.getState().upsertIssue(e.issue);
      }
    });
    return off;
  }, [enabled]);
}
