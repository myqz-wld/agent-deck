import { useMemo } from 'react';

import { isRecoverableRelayWorkerOffline } from '@shared/remote-host';
import { REMOTE_HOST_RESOURCE_KINDS } from '@shared/remote-host';
import type {
  RemoteHostProfileDto,
  RemoteHostResourceRevisions,
  RemoteHostStateDto,
} from '@shared/remote-host';
import {
  emptyRemoteHostResourceRevisions,
  type RemoteHostSnapshotState,
} from './use-remote-host-snapshot';
import { remoteSourceIdentity } from './remote-source-utils';

export interface RemoteSourceContext {
  activeProfileId: string | null;
  capabilities: ReadonlySet<string>;
  dataRevision: number;
  resourceRevisions: RemoteHostResourceRevisions;
  identity: string;
  profile: RemoteHostProfileDto | null;
  recoveringWorker: boolean;
  state: RemoteHostStateDto | null;
  usable: boolean;
}

export function useRemoteSourceContext(hosts: RemoteHostSnapshotState): RemoteSourceContext {
  const snapshot = hosts.snapshot;
  const activeProfileId = snapshot?.sourceMode === 'remote'
    ? snapshot.selectedRemoteProfileId
    : null;
  const profile = snapshot?.profiles.find((item) => item.id === activeProfileId) ?? null;
  const state = snapshot?.states.find((item) => item.profileId === activeProfileId) ?? null;
  const identity = activeProfileId
    ? remoteSourceIdentity(
        activeProfileId,
        state?.authoritativeCoreId ?? null,
        state?.workerGeneration ?? null,
      )
    : 'local';
  const recoveringWorker = isRecoverableRelayWorkerOffline(state);
  const dataRevision = activeProfileId
    ? Math.max(
        hosts.dataRevisionByProfile.get('*') ?? 0,
        hosts.dataRevisionByProfile.get(activeProfileId) ?? 0,
      )
    : 0;
  const resourceRevisions = emptyRemoteHostResourceRevisions();
  if (activeProfileId) {
    const wildcard = hosts.resourceRevisionsByProfile.get('*');
    const selected = hosts.resourceRevisionsByProfile.get(activeProfileId);
    for (const resource of REMOTE_HOST_RESOURCE_KINDS) {
      resourceRevisions[resource] = Math.max(
        wildcard?.[resource] ?? 0,
        selected?.[resource] ?? 0,
      );
    }
  }
  const usable = Boolean(
    hosts.snapshotError === null && activeProfileId && profile?.scope === 'remote' &&
    state?.status === 'connected',
  );
  const capabilityKey = (state?.capabilities ?? []).join('\u0000');
  // HostHello capabilities are unique; the joined key ignores snapshot clones.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const capabilities = useMemo<ReadonlySet<string>>(
    () => new Set(state?.capabilities ?? []),
    [capabilityKey],
  );
  return {
    activeProfileId,
    capabilities,
    dataRevision,
    resourceRevisions,
    identity,
    profile,
    recoveringWorker,
    state,
    usable,
  };
}
