import {
  AgentDeckCapability,
  AgentDeckClientErrorCode,
  CORE_METHOD_METADATA,
  DeploymentTopology,
  getTopologyDescriptor,
  isCoreMethodAllowed,
  type AgentDeckCapability as Capability,
  type AuthenticatedClientAccessContext,
  type CoreMethod,
  type HostHello,
} from '@contracts/index';

import { DaemonRequestError, type DaemonConnectionLimits } from './types';

export function normalizeDaemonAccessContext(
  created: AuthenticatedClientAccessContext,
  clientId: string,
  instanceId: string,
  topology: Exclude<DeploymentTopology, 'standalone'> = DeploymentTopology.ServerCore,
): AuthenticatedClientAccessContext {
  if (
    created.kind !== 'authenticated-client' ||
    created.topology !== topology ||
    created.instanceId !== instanceId ||
    created.clientId !== clientId ||
    created.authority !== 'owner-equivalent' ||
    !created.accessCredentialId
  ) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.AccessDenied,
      'Transport-created AccessContext does not match this daemon connection',
    );
  }
  if (created.transport === 'ssh' && created.surface === 'desktop-full') {
    return Object.freeze({
      kind: 'authenticated-client',
      topology,
      instanceId,
      clientId,
      transport: 'ssh',
      accessCredentialId: created.accessCredentialId,
      authority: 'owner-equivalent',
      surface: 'desktop-full',
    });
  }
  if (created.transport === 'feishu' && created.surface === 'feishu-session-console') {
    return Object.freeze({
      kind: 'authenticated-client',
      topology,
      instanceId,
      clientId,
      transport: 'feishu',
      accessCredentialId: created.accessCredentialId,
      authority: 'owner-equivalent',
      surface: 'feishu-session-console',
    });
  }
  throw new DaemonRequestError(
    AgentDeckClientErrorCode.AccessDenied,
    'Transport and AccessContext surface do not match',
  );
}

function capabilities(
  access: AuthenticatedClientAccessContext,
  supportedMethods: ReadonlySet<CoreMethod>,
  replayAvailable: boolean,
  protocolVersion: HostHello['protocolVersion'],
): readonly Capability[] {
  const result = new Set<Capability>();
  for (const method of supportedMethods) {
    if (isCoreMethodAllowed(access.surface, method)) {
      const capability = CORE_METHOD_METADATA[method].capability;
      const minimumMinor = capability === AgentDeckCapability.Usage
        ? 1
        : capability === AgentDeckCapability.NodeConfiguration ||
            capability === AgentDeckCapability.NodeAssets
          ? 2
          : 0;
      if (
        protocolVersion.major > 2 ||
        (protocolVersion.major === 2 && protocolVersion.minor >= minimumMinor)
      ) {
        result.add(capability);
      }
    }
  }
  if (replayAvailable) result.add(AgentDeckCapability.Replay);
  return Object.freeze([...result]);
}

export interface CreateDaemonHostHelloInput {
  readonly protocolVersion: HostHello['protocolVersion'];
  readonly appVersion: string;
  readonly instanceId: string;
  readonly authoritativeCoreId: string;
  readonly topology?: Exclude<DeploymentTopology, 'standalone'>;
  readonly authoritativeCoreGeneration?: number | null;
  readonly access: AuthenticatedClientAccessContext;
  readonly supportedMethods: ReadonlySet<CoreMethod>;
  readonly replayAvailable: boolean;
  readonly limits: DaemonConnectionLimits;
  readonly eventRevision: number;
}

export function createDaemonHostHello(input: CreateDaemonHostHelloInput): HostHello {
  const topology = input.topology ?? DeploymentTopology.ServerCore;
  return {
    protocolVersion: input.protocolVersion,
    appVersion: input.appVersion,
    topology,
    instanceId: input.instanceId,
    authoritativeCore: {
      id: input.authoritativeCoreId,
      location: getTopologyDescriptor(topology).authoritativeCoreLocation,
      generation: input.authoritativeCoreGeneration ?? null,
    },
    access: input.access,
    capabilities: capabilities(
      input.access,
      input.supportedMethods,
      input.replayAvailable,
      input.protocolVersion,
    ),
    limits: {
      maxFrameBytes: input.limits.maxFrameBytes,
      maxBlobBytes: input.limits.maxBlobBytes,
      maxConcurrentRequests: input.limits.maxConcurrentRequests,
      maxQueuedEvents: input.limits.maxQueuedEvents,
    },
    eventRevision: input.eventRevision,
  };
}
