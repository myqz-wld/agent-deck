import type {
  ElectronHostProfile,
  RemoteElectronHostProfile,
} from './model';

export interface ElectronHostPublicEndpoint {
  hostname: string;
  port: number;
  username: string;
  expectedInstanceId: string | null;
  hostKeyAlias: string | null;
}

export interface ElectronHostPublicProfile {
  id: string;
  label: string;
  clientId: string;
  topology: ElectronHostProfile['topology'];
  endpoint: ElectronHostPublicEndpoint | null;
}

function publicEndpoint(profile: RemoteElectronHostProfile): ElectronHostPublicEndpoint {
  return {
    hostname: profile.ssh.hostname,
    port: profile.ssh.port,
    username: profile.ssh.username,
    expectedInstanceId: profile.ssh.expectedInstanceId ?? null,
    hostKeyAlias: profile.ssh.hostKeyAlias ?? null,
  };
}

/** Renderer-safe projection: key, known-hosts, SSH binary, and raw transport objects never cross. */
export function publicElectronHostProfile(
  profile: ElectronHostProfile,
): ElectronHostPublicProfile {
  return {
    id: profile.id,
    label: profile.label,
    clientId: profile.clientId,
    topology: profile.topology,
    endpoint: profile.topology === 'standalone' ? null : publicEndpoint(profile),
  };
}
