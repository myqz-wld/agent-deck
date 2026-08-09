import type { AgentDeckSubscription, HostHello } from '@contracts/index';
import type { SshConnectionState } from '@clients/ssh';

import type { ElectronHostClientBinding } from './client-binding';
import type {
  ElectronHostNavigationState,
  ElectronHostProfile,
  ElectronHostState,
} from './model';
import type { HostQualifiedIdentity } from './identity';

export interface RegistryEntry {
  profile: ElectronHostProfile;
  state: ElectronHostState;
  navigation: ElectronHostNavigationState;
  identity: HostQualifiedIdentity | null;
  binding: ElectronHostClientBinding | null;
  transportSubscription: AgentDeckSubscription | null;
  eventSubscription: AgentDeckSubscription | null;
  connectPromise: Promise<HostHello> | null;
  transportState: SshConnectionState | null;
  retirement: Promise<void> | null;
  epoch: number;
}
