import type {
  AgentDeckCapability,
  AgentDeckEventEnvelope,
  DeploymentTopology,
} from '@contracts/index';

import type { SshHostProfile } from '@clients/ssh';

interface ElectronHostProfileBase {
  id: string;
  label: string;
  clientId: string;
}

export interface StandaloneElectronHostProfile extends ElectronHostProfileBase {
  topology: 'standalone';
}

export interface RemoteElectronHostProfile extends ElectronHostProfileBase {
  topology: 'relay' | 'full';
  ssh: SshHostProfile;
}

export type ElectronHostProfile =
  | StandaloneElectronHostProfile
  | RemoteElectronHostProfile;

export type ElectronHostConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'incompatible'
  | 'offline';

export interface ElectronHostErrorSummary {
  code: string;
  message: string;
}

export interface ElectronHostState {
  profileId: string;
  clientId: string;
  topology: DeploymentTopology;
  status: ElectronHostConnectionStatus;
  instanceId: string | null;
  authoritativeCoreId: string | null;
  workerGeneration: number | null;
  capabilities: readonly AgentDeckCapability[];
  eventRevision: number;
  error: ElectronHostErrorSummary | null;
}

export interface ElectronHostNavigationState {
  selectedSessionId: string | null;
  route: string | null;
  revision: number;
}

export interface ElectronHostStateSubscription {
  close(): void;
}

export interface ElectronHostEvent extends AgentDeckEventEnvelope {
  profileId: string;
}

export function initialElectronHostState(profile: ElectronHostProfile): ElectronHostState {
  return {
    profileId: profile.id,
    clientId: profile.clientId,
    topology: profile.topology,
    status: 'offline',
    instanceId: profile.topology === 'standalone' ? 'local' : null,
    authoritativeCoreId: null,
    workerGeneration: null,
    capabilities: [],
    eventRevision: 0,
    error: null,
  };
}

export function initialNavigationState(): ElectronHostNavigationState {
  return { selectedSessionId: null, route: null, revision: 0 };
}
