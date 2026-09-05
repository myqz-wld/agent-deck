import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  RemoteHostProfileDraftDto,
  RemoteHostResourceKind,
  RemoteHostResourceRevisions,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
} from '@shared/remote-host';
import { REMOTE_HOST_RESOURCE_KINDS } from '@shared/remote-host';
import {
  appendRemoteSessionRename,
  remoteSourceIdentity,
  type RemoteSessionRenameAliases,
} from './remote-source-utils';

export interface RemoteHostSnapshotState {
  snapshot: RemoteHostSnapshotDto | null;
  dataRevisionByProfile: ReadonlyMap<string, number>;
  resourceRevisionsByProfile: ReadonlyMap<string, RemoteHostResourceRevisions>;
  sessionRenamesBySource?: ReadonlyMap<string, RemoteSessionRenameAliases>;
  mutations: RemoteHostMutationActivity;
  busy: boolean;
  error: string | null;
  snapshotError: string | null;
  refresh(): Promise<void>;
  addProfile(draft: RemoteHostProfileDraftDto): Promise<void>;
  updateProfile(profileId: string, draft: RemoteHostProfileDraftDto): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  selectProfile(profileId: string, options?: { activate: boolean }): Promise<void>;
  setSourceMode(mode: RemoteHostSourceMode): Promise<void>;
  connect(profileId: string): Promise<void>;
  disconnect(profileId: string): Promise<void>;
  clearError(): void;
}

export interface RemoteHostMutationActivity {
  profileRegistry: boolean;
  sourceSelection: boolean;
  connectingProfileIds: ReadonlySet<string>;
  disconnectingProfileIds: ReadonlySet<string>;
}

const RESOURCE_KIND_SET = new Set<string>(REMOTE_HOST_RESOURCE_KINDS);
const PROFILE_REGISTRY_MUTATION = 'profile-registry';
const SOURCE_SELECTION_MUTATION = 'source-selection';
const CONNECTION_MUTATION_PREFIX = 'connection:';
const DISCONNECTION_MUTATION_PREFIX = 'connection-stop:';

function projectMutationActivity(
  pending: ReadonlyMap<string, number>,
): RemoteHostMutationActivity {
  const connectingProfileIds = new Set<string>();
  const disconnectingProfileIds = new Set<string>();
  for (const key of pending.keys()) {
    if (key.startsWith(CONNECTION_MUTATION_PREFIX)) {
      connectingProfileIds.add(key.slice(CONNECTION_MUTATION_PREFIX.length));
    } else if (key.startsWith(DISCONNECTION_MUTATION_PREFIX)) {
      disconnectingProfileIds.add(key.slice(DISCONNECTION_MUTATION_PREFIX.length));
    }
  }
  return {
    profileRegistry: pending.has(PROFILE_REGISTRY_MUTATION),
    sourceSelection: pending.has(SOURCE_SELECTION_MUTATION),
    connectingProfileIds,
    disconnectingProfileIds,
  };
}

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
  const [sessionRenamesBySource, setSessionRenamesBySource] = useState<
    ReadonlyMap<string, RemoteSessionRenameAliases>
  >(new Map());
  const [pendingMutations, setPendingMutations] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const autoConnectAttempt = useRef<string | null>(null);
  const autoConnectGeneration = useRef(0);
  const mutationTails = useRef(new Map<string, Promise<void>>());
  const mutationSequence = useRef(0);
  const sourceSelectionSequence = useRef(0);
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

  const markMutation = useCallback((key: string, delta: 1 | -1): void => {
    setPendingMutations((current) => {
      const next = new Map(current);
      const count = (next.get(key) ?? 0) + delta;
      if (count > 0) next.set(key, count);
      else next.delete(key);
      return next;
    });
  }, []);

  const mutate = useCallback((
    key: string,
    operation: () => Promise<RemoteHostSnapshotDto>,
  ): Promise<void> => {
    const operationSequence = ++mutationSequence.current;
    markMutation(key, 1);
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
      markMutation(key, -1);
    });
  }, [apply, markMutation]);

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
      if (event.profileId && event.sessionRename) {
        const rename = event.sessionRename;
        const sourceIdentity = remoteSourceIdentity(
          event.profileId,
          rename.authoritativeCoreId,
          rename.workerGeneration,
        );
        setSessionRenamesBySource((current) => {
          const next = new Map(current);
          next.delete(sourceIdentity);
          next.set(sourceIdentity, appendRemoteSessionRename(
            current.get(sourceIdentity),
            rename.fromId,
            rename.toId,
          ));
          while (next.size > 32) next.delete(next.keys().next().value as string);
          return next;
        });
      }
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
      autoConnectGeneration.current += 1;
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
    const generation = ++autoConnectGeneration.current;
    void mutate(
      `${CONNECTION_MUTATION_PREFIX}${selectedRemoteProfileId}`,
      () => window.api.connectRemoteHost(selectedRemoteProfileId),
    ).catch((reason) => {
      if (
        autoConnectGeneration.current === generation &&
        activeRemoteProfileId.current === selectedRemoteProfileId
      ) {
        setError(errorMessage(reason));
      }
    });
  }, [mutate, selectedRemoteProfileId, selectedRemoteStatus]);
  const setSourceMode = useCallback(
    (mode: RemoteHostSourceMode) => {
      sourceSelectionSequence.current += 1;
      return mutate(SOURCE_SELECTION_MUTATION, () => window.api.setRemoteHostSourceMode(mode));
    },
    [mutate],
  );
  const selectProfile = useCallback((profileId: string, options?: { activate: boolean }) => {
    const intent = ++sourceSelectionSequence.current;
    // Queue the complete choice. A newer header or profile-manager choice also fences the
    // optional activation before it reaches persistence, rather than just ignoring its snapshot.
    return mutate(SOURCE_SELECTION_MUTATION, async () => {
      const selected = await window.api.selectRemoteHostProfile(profileId);
      if (!options?.activate || intent !== sourceSelectionSequence.current) return selected;
      return window.api.setRemoteHostSourceMode('remote');
    });
  }, [mutate]);

  const mutations = projectMutationActivity(pendingMutations);

  return {
    snapshot,
    dataRevisionByProfile,
    resourceRevisionsByProfile,
    sessionRenamesBySource,
    mutations,
    busy: pendingMutations.size > 0,
    error,
    snapshotError,
    refresh,
    addProfile: (draft) => mutate(
      PROFILE_REGISTRY_MUTATION,
      () => window.api.addRemoteHostProfile(draft),
    ),
    updateProfile: (profileId, draft) =>
      mutate(
        PROFILE_REGISTRY_MUTATION,
        () => window.api.updateRemoteHostProfile(profileId, draft),
      ),
    removeProfile: (profileId) => mutate(
      PROFILE_REGISTRY_MUTATION,
      () => window.api.removeRemoteHostProfile(profileId),
    ),
    selectProfile,
    setSourceMode,
    connect: (profileId) => {
      autoConnectAttempt.current = profileId;
      autoConnectGeneration.current += 1;
      return mutate(
        `${CONNECTION_MUTATION_PREFIX}${profileId}`,
        () => window.api.connectRemoteHost(profileId),
      );
    },
    disconnect: (profileId) => {
      // An explicit stop is a cancellation boundary, not another item behind connect/reconnect.
      // Main/registry disconnect closes the SSH binding, which clears its retry timer, retires the
      // active child, and rejects the older connect waiter.
      autoConnectAttempt.current = profileId;
      autoConnectGeneration.current += 1;
      return mutate(
        `${DISCONNECTION_MUTATION_PREFIX}${profileId}`,
        () => window.api.disconnectRemoteHost(profileId),
      );
    },
    clearError: () => {
      errorOwner.current = null;
      setError(null);
    },
  };
}
