export const DeploymentTopology = {
  Standalone: 'standalone',
  ServerCore: 'server-core',
  Relay: 'relay',
} as const;

export type DeploymentTopology =
  (typeof DeploymentTopology)[keyof typeof DeploymentTopology];

export type AccessTransport = 'local-ipc' | 'ssh' | 'feishu';

export type AuthoritativeCoreLocation =
  | 'local-process'
  | 'server-appliance'
  | 'local-worker';

export interface TopologyDescriptor {
  topology: DeploymentTopology;
  authoritativeCoreLocation: AuthoritativeCoreLocation;
  accessTransports: readonly AccessTransport[];
  serverParticipates: boolean;
  serverExecutesAgents: boolean;
}

export const TOPOLOGY_DESCRIPTORS = {
  [DeploymentTopology.Standalone]: {
    topology: DeploymentTopology.Standalone,
    authoritativeCoreLocation: 'local-process',
    accessTransports: ['local-ipc'],
    serverParticipates: false,
    serverExecutesAgents: false,
  },
  [DeploymentTopology.ServerCore]: {
    topology: DeploymentTopology.ServerCore,
    authoritativeCoreLocation: 'server-appliance',
    accessTransports: ['ssh', 'feishu'],
    serverParticipates: true,
    serverExecutesAgents: true,
  },
  [DeploymentTopology.Relay]: {
    topology: DeploymentTopology.Relay,
    authoritativeCoreLocation: 'local-worker',
    accessTransports: ['ssh', 'feishu'],
    serverParticipates: true,
    serverExecutesAgents: false,
  },
} as const satisfies Record<DeploymentTopology, TopologyDescriptor>;

export function getTopologyDescriptor(topology: DeploymentTopology): TopologyDescriptor {
  return TOPOLOGY_DESCRIPTORS[topology];
}

export function supportsRemoteAccess(topology: DeploymentTopology): boolean {
  return topology !== DeploymentTopology.Standalone;
}
