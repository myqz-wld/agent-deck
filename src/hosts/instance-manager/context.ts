import type {
  InstanceManagerPorts,
  InstanceManagerRoots,
  ManagerLimits,
} from './types';

export interface InstanceManagerContext {
  readonly ports: InstanceManagerPorts;
  readonly roots: InstanceManagerRoots;
  readonly limits: ManagerLimits;
  readonly serviceUid: number;
  readonly trustedRootUid: number;
  readonly trustedArtifactUid: number;
}
