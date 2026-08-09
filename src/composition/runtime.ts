import type { AgentDeckClient, AgentDeckMethodMap, DeploymentTopology } from '@contracts/index';

export type CompositionRole =
  | 'local-worker'
  | 'relay-server'
  | 'server-core-host'
  | 'standalone-host';

export interface LifecycleComponent {
  readonly name: string;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface AgentDeckComposition<Methods = AgentDeckMethodMap> {
  readonly topology: DeploymentTopology;
  readonly role: CompositionRole;
  readonly components: readonly LifecycleComponent[];
  readonly client: AgentDeckClient<Methods> | null;
}

export interface AgentDeckCompositionRoot<Methods = AgentDeckMethodMap> {
  create(): Promise<AgentDeckComposition<Methods>>;
}
