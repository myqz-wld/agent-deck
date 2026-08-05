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
    topology: profile.topology,
    endpoint: profile.topology === 'standalone' ? null : {
      hostname: profile.ssh.hostname,
      port: profile.ssh.port,
      username: profile.ssh.username,
      expectedInstanceId: profile.ssh.expectedInstanceId ?? null,
      hostKeyAlias: profile.ssh.hostKeyAlias ?? null,
    },
    credentials: {
      identityFileConfigured: profile.topology !== 'standalone',
      knownHostsFileConfigured: profile.topology !== 'standalone',
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
      topology: state.topology,
      status: state.status,
      instanceId: state.instanceId,
      authoritativeCoreId: state.authoritativeCoreId,
      workerGeneration: state.workerGeneration,
      capabilities: [...state.capabilities],
      eventRevision: state.eventRevision,
      error: publicConnectionError(state.error),
    } satisfies RemoteHostStateDto)),
  };
}
