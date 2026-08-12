import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  RemoteHostProfileDraftDto,
  RemoteHostResourceKind,
  RemoteHostResourceRevisions,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
} from '@shared/remote-host';
import { REMOTE_HOST_RESOURCE_KINDS } from '@shared/remote-host';

export interface RemoteHostSnapshotState {
  snapshot: RemoteHostSnapshotDto | null;
  dataRevisionByProfile: ReadonlyMap<string, number>;
  resourceRevisionsByProfile: ReadonlyMap<string, RemoteHostResourceRevisions>;
  busy: boolean;
  error: string | null;
  snapshotError: string | null;
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

const RESOURCE_KIND_SET = new Set<string>(REMOTE_HOST_RESOURCE_KINDS);

export function emptyRemoteHostResourceRevisions(): RemoteHostResourceRevisions {
  return Object.fromEntries(
    REMOTE_HOST_RESOURCE_KINDS.map((kind) => [kind, 0]),
  ) as RemoteHostResourceRevisions;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useRemoteHostSnapshot(): RemoteHostSnapshotState {
  const [snapshot, setSnapshot] = useState<RemoteHostSnapshotDto | null>(null);
  const [dataRevisionByProfile, setDataRevisionByProfile] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [resourceRevisionsByProfile, setResourceRevisionsByProfile] = useState<
    ReadonlyMap<string, RemoteHostResourceRevisions>
  >(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const autoConnectAttempt = useRef<string | null>(null);
  const mutationTails = useRef(new Map<string, Promise<void>>());
  const mutationCount = useRef(0);
  const mutationSequence = useRef(0);
  const errorOwner = useRef<'refresh' | 'mutation' | null>(null);

  const apply = useCallback((next: RemoteHostSnapshotDto): void => {
    setSnapshot((current) => !current || next.revision >= current.revision ? next : current);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current;
    try {
      const next = await window.api.getRemoteHostSnapshot();
      if (sequence === requestSequence.current) {
        apply(next);
        setSnapshotError(null);
        if (errorOwner.current === 'refresh') {
          errorOwner.current = null;
          setError(null);
        }
      }
    } catch (reason) {
      if (sequence === requestSequence.current) {
        errorOwner.current = 'refresh';
        const message = errorMessage(reason);
        setSnapshotError(message);
        setError(message);
      }
    }
  }, [apply]);

  const mutate = useCallback((
    key: string,
    operation: () => Promise<RemoteHostSnapshotDto>,
  ): Promise<void> => {
    const operationSequence = ++mutationSequence.current;
    mutationCount.current += 1;
    setBusy(true);
    errorOwner.current = null;
    setError(null);
    const previous = mutationTails.current.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      try {
        apply(await operation());
        setSnapshotError(null);
      } catch (reason) {
        if (operationSequence === mutationSequence.current) {
          errorOwner.current = 'mutation';
          setError(errorMessage(reason));
        }
        throw reason;
      }
    });
    const tail = run.catch(() => undefined);
    mutationTails.current.set(key, tail);
    return run.finally(() => {
      if (mutationTails.current.get(key) === tail) mutationTails.current.delete(key);
      mutationCount.current -= 1;
      if (mutationCount.current === 0) setBusy(false);
    });
  }, [apply]);

  useEffect(() => {
    let snapshotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotMaxTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotWindowOpen = false;
    let snapshotPending = false;
    let dataTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingDataRevisions = new Map<string, number>();
    const pendingResourceRevisions = new Map<
      string,
      Map<RemoteHostResourceKind, number>
    >();
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
        const resourceRevisions = pendingResourceRevisions.get(key) ?? new Map();
        const resources = Array.isArray(event.resources)
          ? event.resources.filter((kind): kind is RemoteHostResourceKind =>
              RESOURCE_KIND_SET.has(kind))
          : [];
        for (const resource of resources.length > 0 ? resources : REMOTE_HOST_RESOURCE_KINDS) {
          resourceRevisions.set(
            resource,
            Math.max(resourceRevisions.get(resource) ?? 0, event.revision),
          );
        }
        pendingResourceRevisions.set(key, resourceRevisions);
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
            setResourceRevisionsByProfile((current) => {
              const next = new Map(current);
              for (const [profileId, pending] of pendingResourceRevisions) {
                const revisions = { ...(next.get(profileId) ?? emptyRemoteHostResourceRevisions()) };
                for (const [resource, revision] of pending) {
                  revisions[resource] = Math.max(revisions[resource], revision);
                }
                next.set(profileId, revisions);
              }
              pendingResourceRevisions.clear();
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

  const selectedRemoteProfileId = snapshot?.sourceMode === 'remote'
    ? snapshot.selectedRemoteProfileId
    : null;
  const selectedRemoteStatus = selectedRemoteProfileId
    ? snapshot?.states.find((state) => state.profileId === selectedRemoteProfileId)?.status ?? null
    : null;
  const activeRemoteProfileId = useRef(selectedRemoteProfileId);
  activeRemoteProfileId.current = selectedRemoteProfileId;
  useEffect(() => {
    if (!selectedRemoteProfileId) {
      autoConnectAttempt.current = null;
      return;
    }
    if (
      selectedRemoteStatus === 'connected' ||
      selectedRemoteStatus === 'connecting' ||
      selectedRemoteStatus === 'reconnecting'
    ) {
      autoConnectAttempt.current = selectedRemoteProfileId;
      return;
    }
    if (
      selectedRemoteStatus !== 'offline' ||
      autoConnectAttempt.current === selectedRemoteProfileId
    ) return;

    autoConnectAttempt.current = selectedRemoteProfileId;
    void mutate(
      `connection:${selectedRemoteProfileId}`,
      () => window.api.connectRemoteHost(selectedRemoteProfileId),
    ).catch((reason) => {
      if (activeRemoteProfileId.current === selectedRemoteProfileId) {
        setError(errorMessage(reason));
      }
    });
  }, [mutate, selectedRemoteProfileId, selectedRemoteStatus]);
  const setSourceMode = useCallback(
    (mode: RemoteHostSourceMode) => mutate(
      'source-selection',
      () => window.api.setRemoteHostSourceMode(mode),
    ),
    [mutate],
  );

  return {
    snapshot,
    dataRevisionByProfile,
    resourceRevisionsByProfile,
    busy,
    error,
    snapshotError,
    refresh,
    addProfile: (draft) => mutate('profile-registry', () => window.api.addRemoteHostProfile(draft)),
    updateProfile: (profileId, draft) =>
      mutate('profile-registry', () => window.api.updateRemoteHostProfile(profileId, draft)),
    removeProfile: (profileId) => mutate(
      'profile-registry',
      () => window.api.removeRemoteHostProfile(profileId),
    ),
    selectProfile: (profileId) => mutate(
      'source-selection',
      () => window.api.selectRemoteHostProfile(profileId),
    ),
    setSourceMode,
    connect: (profileId) => mutate(
      `connection:${profileId}`,
      () => window.api.connectRemoteHost(profileId),
    ),
    disconnect: (profileId) => mutate(
      `connection:${profileId}`,
      () => window.api.disconnectRemoteHost(profileId),
    ),
    clearError: () => {
      errorOwner.current = null;
      setError(null);
    },
  };
}
