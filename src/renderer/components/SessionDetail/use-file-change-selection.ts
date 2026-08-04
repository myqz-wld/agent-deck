import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { FileChangeSummary } from '@shared/types';
import { pickLatestChange } from './helpers';

interface UseFileChangeSelectionArgs {
  changes: FileChangeSummary[] | null;
  sessionId: string;
  workspaceKey: string;
}

/**
 * Keeps the live diff on the newest change until the user deliberately selects a file or revision.
 * A cwd boundary starts a fresh follow-latest view without discarding the session's stored history.
 */
export function useFileChangeSelection({
  changes,
  sessionId,
  workspaceKey,
}: UseFileChangeSelectionArgs) {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<number | null>(null);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [manualLatestBaselineId, setManualLatestBaselineId] = useState<number | null>(null);
  const latest = useMemo(() => (changes ? pickLatestChange(changes) : null), [changes]);

  useLayoutEffect(() => {
    setSelectedFilePath(null);
    setSelectedChangeId(null);
    setFollowingLatest(true);
    setManualLatestBaselineId(null);
  }, [sessionId, workspaceKey]);

  useEffect(() => {
    if (!changes) return;
    if (followingLatest) {
      setSelectedFilePath(latest?.filePath ?? null);
      setSelectedChangeId(latest?.id ?? null);
      setManualLatestBaselineId(latest?.id ?? null);
      return;
    }

    const selectionStillExists =
      selectedFilePath !== null &&
      selectedChangeId !== null &&
      changes.some(
        (change) =>
          change.filePath === selectedFilePath && change.id === selectedChangeId,
      );
    if (selectionStillExists) return;

    setSelectedFilePath(latest?.filePath ?? null);
    setSelectedChangeId(latest?.id ?? null);
    setFollowingLatest(true);
    setManualLatestBaselineId(latest?.id ?? null);
  }, [changes, followingLatest, latest, selectedChangeId, selectedFilePath]);

  const beginManualSelection = useCallback(() => {
    setFollowingLatest(false);
    setManualLatestBaselineId(latest?.id ?? null);
  }, [latest]);

  const selectFile = useCallback(
    (filePath: string, latestChangeId: number) => {
      beginManualSelection();
      setSelectedFilePath(filePath);
      setSelectedChangeId(latestChangeId);
    },
    [beginManualSelection],
  );

  const selectChange = useCallback(
    (changeId: number) => {
      beginManualSelection();
      setSelectedChangeId(changeId);
    },
    [beginManualSelection],
  );

  const followLatest = useCallback(() => {
    setFollowingLatest(true);
    setSelectedFilePath(latest?.filePath ?? null);
    setSelectedChangeId(latest?.id ?? null);
    setManualLatestBaselineId(latest?.id ?? null);
  }, [latest]);

  return {
    selectedFilePath,
    selectedChangeId,
    followingLatest,
    hasNewerChanges:
      !followingLatest && latest !== null && latest.id !== manualLatestBaselineId,
    selectFile,
    selectChange,
    followLatest,
  };
}
