import type { ElectronHostProfile, ElectronHostRegistry } from '@hosts/electron';
import type {
  RemoteHostProfileDto,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
  RemoteHostStateDto,
} from '@shared/remote-host';

import { publicConnectionError } from './errors';

function publicProfile(profile: ElectronHostProfile): RemoteHostProfileDto {
  return {
    id: profile.id,
    label: profile.label,
    scope: profile.topology === 'standalone' ? 'local' : 'remote',
    endpoint: profile.topology === 'standalone' ? null : {
      hostname: profile.ssh.hostname,
      port: profile.ssh.port,
      username: profile.ssh.username,
      hostKeyFingerprint: profile.ssh.hostKeyFingerprint ?? null,
    },
    credentials: {
      connectionCredentialConfigured: profile.topology !== 'standalone' &&
        profile.connectionCredentialStatus !== 'refresh-required',
    },
  };
}

export function remoteHostSnapshot(input: {
  registry: ElectronHostRegistry;
  revision: number;
  selectedRemoteProfileId: string | null;
  sourceMode: RemoteHostSourceMode;
}): RemoteHostSnapshotDto {
  return {
    revision: input.revision,
    sourceMode: input.sourceMode,
    selectedRemoteProfileId: input.selectedRemoteProfileId,
    profiles: input.registry.listProfiles().map(publicProfile),
    states: input.registry.listStates().map((state) => ({
      profileId: state.profileId,
      status: state.status,
      recovery: (
        state.topology === 'relay' && state.status === 'offline' &&
        state.error?.code === 'worker_offline'
      ) ? 'worker-offline' : null,
      authoritativeCoreId: state.authoritativeCoreId,
      workerGeneration: state.workerGeneration,
      capabilities: [...state.capabilities],
      eventRevision: state.eventRevision,
      error: publicConnectionError(state.error),
    } satisfies RemoteHostStateDto)),
  };
}
