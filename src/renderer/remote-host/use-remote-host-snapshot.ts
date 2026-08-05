import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  RemoteHostProfileDraftDto,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
} from '@shared/remote-host';

export interface RemoteHostSnapshotState {
  snapshot: RemoteHostSnapshotDto | null;
  dataRevisionByProfile: ReadonlyMap<string, number>;
  busy: boolean;
  error: string | null;
  refresh(): Promise<void>;
  addProfile(draft: RemoteHostProfileDraftDto): Promise<void>;
  updateProfile(profileId: string, draft: RemoteHostProfileDraftDto): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  selectProfile(profileId: string): Promise<void>;
  setSourceMode(mode: RemoteHostSourceMode): Promise<void>;
  connect(profileId: string): Promise<void>;
  disconnect(profileId: string): Promise<void>;
  clearError(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useRemoteHostSnapshot(): RemoteHostSnapshotState {
  const [snapshot, setSnapshot] = useState<RemoteHostSnapshotDto | null>(null);
  const [dataRevisionByProfile, setDataRevisionByProfile] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const apply = useCallback((next: RemoteHostSnapshotDto): void => {
    setSnapshot((current) => !current || next.revision >= current.revision ? next : current);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current;
    try {
      const next = await window.api.getRemoteHostSnapshot();
      if (sequence === requestSequence.current) apply(next);
    } catch (reason) {
      if (sequence === requestSequence.current) setError(errorMessage(reason));
    }
  }, [apply]);

  useEffect(() => {
    let snapshotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotMaxTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotWindowOpen = false;
    let snapshotPending = false;
    let dataTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingDataRevisions = new Map<string, number>();
    const finishSnapshotWindow = (): void => {
      if (snapshotDebounceTimer) clearTimeout(snapshotDebounceTimer);
      if (snapshotMaxTimer) clearTimeout(snapshotMaxTimer);
      snapshotDebounceTimer = null;
      snapshotMaxTimer = null;
      snapshotWindowOpen = false;
      const shouldRefresh = snapshotPending;
      snapshotPending = false;
      if (shouldRefresh) void refresh();
    };
    const scheduleSnapshot = (): void => {
      if (!snapshotWindowOpen) {
        snapshotWindowOpen = true;
        snapshotPending = false;
        void refresh();
        snapshotMaxTimer = setTimeout(finishSnapshotWindow, 200);
        return;
      }
      snapshotPending = true;
      if (snapshotDebounceTimer) clearTimeout(snapshotDebounceTimer);
      snapshotDebounceTimer = setTimeout(finishSnapshotWindow, 50);
    };
    const off = window.api.onRemoteHostChanged((event) => {
      if (event.reason === 'data') {
        const key = event.profileId ?? '*';
        pendingDataRevisions.set(
          key,
          Math.max(pendingDataRevisions.get(key) ?? 0, event.revision),
        );
        if (!dataTimer) {
          dataTimer = setTimeout(() => {
            dataTimer = null;
            setDataRevisionByProfile((current) => {
              const next = new Map(current);
              for (const [profileId, revision] of pendingDataRevisions) {
                next.set(profileId, Math.max(next.get(profileId) ?? 0, revision));
              }
              pendingDataRevisions.clear();
              return next;
            });
          }, 200);
        }
      }
      scheduleSnapshot();
    });
    void refresh();
    return () => {
      requestSequence.current += 1;
      if (snapshotDebounceTimer) clearTimeout(snapshotDebounceTimer);
      if (snapshotMaxTimer) clearTimeout(snapshotMaxTimer);
      if (dataTimer) clearTimeout(dataTimer);
      off();
    };
  }, [refresh]);

  const mutate = useCallback(async (
    operation: () => Promise<RemoteHostSnapshotDto>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      apply(await operation());
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, [apply]);
  const setSourceMode = useCallback(
    (mode: RemoteHostSourceMode) => mutate(() => window.api.setRemoteHostSourceMode(mode)),
    [mutate],
  );

  return {
    snapshot,
    dataRevisionByProfile,
    busy,
    error,
    refresh,
    addProfile: (draft) => mutate(() => window.api.addRemoteHostProfile(draft)),
    updateProfile: (profileId, draft) =>
      mutate(() => window.api.updateRemoteHostProfile(profileId, draft)),
    removeProfile: (profileId) => mutate(() => window.api.removeRemoteHostProfile(profileId)),
    selectProfile: (profileId) => mutate(() => window.api.selectRemoteHostProfile(profileId)),
    setSourceMode,
    connect: (profileId) => mutate(() => window.api.connectRemoteHost(profileId)),
    disconnect: (profileId) => mutate(() => window.api.disconnectRemoteHost(profileId)),
    clearError: () => setError(null),
  };
}
