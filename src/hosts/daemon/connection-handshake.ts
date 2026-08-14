import {
  AgentDeckCapability,
  AgentDeckClientErrorCode,
  CORE_METHOD_METADATA,
  DeploymentTopology,
  getTopologyDescriptor,
  isCoreMethodGranted,
  copyRemoteOwnerGrantClaim,
  assertRemoteOwnerGrantForSurface,
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
  topology: Exclude<DeploymentTopology, 'standalone'> = DeploymentTopology.Full,
): AuthenticatedClientAccessContext {
  if (
    created.kind !== 'authenticated-client' ||
    created.topology !== topology ||
    created.instanceId !== instanceId ||
    created.clientId !== clientId ||
    created.authority !== 'owner-equivalent' ||
    !created.connectionScope
  ) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.AccessDenied,
      'Transport-created AccessContext does not match this daemon connection',
    );
  }
  try {
    assertRemoteOwnerGrantForSurface(created.grant, created.surface);
  } catch {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.AccessDenied,
      'Server-issued grant does not match the admitted surface',
    );
  }
  if (created.transport === 'ssh' && created.surface === 'desktop') {
    return Object.freeze({
      kind: 'authenticated-client',
      topology,
      instanceId,
      clientId,
      transport: 'ssh',
      connectionScope: created.connectionScope,
      authority: 'owner-equivalent',
      surface: 'desktop',
      grant: copyRemoteOwnerGrantClaim(created.grant),
    });
  }
  if (created.transport === 'feishu' && created.surface === 'feishu') {
    return Object.freeze({
      kind: 'authenticated-client',
      topology,
      instanceId,
      clientId,
      transport: 'feishu',
      connectionScope: created.connectionScope,
      authority: 'owner-equivalent',
      surface: 'feishu',
      grant: copyRemoteOwnerGrantClaim(created.grant),
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
): readonly Capability[] {
  const result = new Set<Capability>();
  for (const method of supportedMethods) {
    if (isCoreMethodGranted(access, method)) {
      const capability = CORE_METHOD_METADATA[method].capability;
      result.add(capability);
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
  const topology = input.topology ?? DeploymentTopology.Full;
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
