import {
  DeploymentTopology,
  type AgentDeckClient,
  type AgentDeckMethodMap,
} from '@contracts/index';
import type { DaemonHost } from '@hosts/daemon';
import type { DaemonSshBridgeListener } from '@hosts/daemon/ssh-bridge-listener';
import type { WorkerAttachmentController } from '@hosts/local-worker';
import type { RelayControlSocketService } from '@hosts/relay';

import type { AgentDeckComposition, LifecycleComponent } from './runtime';

export function daemonHostComponent(host: DaemonHost): LifecycleComponent {
  return {
    name: 'server-core-daemon',
    start: () => host.start(),
    stop: (reason) => host.stop(reason),
  };
}

export function daemonSshBridgeComponent(
  bridge: DaemonSshBridgeListener,
): LifecycleComponent {
  return {
    name: 'server-core-ssh-bridge',
    start: () => bridge.start(),
    stop: () => bridge.stop(),
  };
}

export function localWorkerAttachmentComponent(
  worker: WorkerAttachmentController,
): LifecycleComponent {
  return {
    name: 'relay-worker-attachment',
    start: () => worker.start(),
    stop: () => worker.stop(),
  };
}

export function relayControlSocketComponent(
  service: RelayControlSocketService,
): LifecycleComponent {
  return {
    name: 'relay-control-socket',
    start: () => service.start(),
    stop: () => service.stop(),
  };
}

export interface StandaloneCompositionOptions<Methods = AgentDeckMethodMap> {
  readonly client: AgentDeckClient<Methods>;
  readonly components: readonly LifecycleComponent[];
}

export function createStandaloneComposition<Methods = AgentDeckMethodMap>(
  options: StandaloneCompositionOptions<Methods>,
): AgentDeckComposition<Methods> {
  return Object.freeze({
    topology: DeploymentTopology.Standalone,
    role: 'standalone-host' as const,
    components: Object.freeze([...options.components]),
    client: options.client,
  });
}

export interface ServerCoreCompositionOptions {
  readonly host: DaemonHost;
  readonly sshBridge: DaemonSshBridgeListener;
  readonly beforeIngress?: readonly LifecycleComponent[];
}

export function createServerCoreComposition(
  options: ServerCoreCompositionOptions,
): AgentDeckComposition {
  return Object.freeze({
    topology: DeploymentTopology.Full,
    role: 'server-core-host' as const,
    components: Object.freeze([
      daemonHostComponent(options.host),
      ...(options.beforeIngress ?? []),
      daemonSshBridgeComponent(options.sshBridge),
    ]),
    client: null,
  });
}

export interface RelayServerCompositionOptions {
  readonly components: readonly LifecycleComponent[];
}

export function createRelayServerComposition(
  options: RelayServerCompositionOptions,
): AgentDeckComposition {
  return Object.freeze({
    topology: DeploymentTopology.Relay,
    role: 'relay-server' as const,
    components: Object.freeze([...options.components]),
    client: null,
  });
}

export interface LocalWorkerCompositionOptions {
  readonly core: LifecycleComponent;
  readonly worker: WorkerAttachmentController;
  readonly afterCore?: readonly LifecycleComponent[];
}

export function createLocalWorkerComposition(
  options: LocalWorkerCompositionOptions,
): AgentDeckComposition {
  return Object.freeze({
    topology: DeploymentTopology.Relay,
    role: 'local-worker' as const,
    components: Object.freeze([
      options.core,
      ...(options.afterCore ?? []),
      localWorkerAttachmentComponent(options.worker),
    ]),
    client: null,
  });
}
