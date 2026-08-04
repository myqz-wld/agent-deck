import type { HostHello } from '@contracts/index';
import { hasForbiddenWireControl, utf8ByteLength } from '@clients/ssh';

export interface HostQualifiedIdentity {
  profileId: string;
  topology: HostHello['topology'];
  instanceId: string;
  authoritativeCoreId: string;
  authoritativeCoreGeneration: number | null;
}

export function identityFromHostHello(
  profileId: string,
  hello: HostHello,
): HostQualifiedIdentity {
  return {
    profileId,
    topology: hello.topology,
    instanceId: hello.instanceId,
    authoritativeCoreId: hello.authoritativeCore.id,
    authoritativeCoreGeneration: hello.authoritativeCore.generation,
  };
}

function encodePart(value: string): string {
  if (value.length === 0 || hasForbiddenWireControl(value)) {
    throw new Error('Host-qualified key components must be non-empty and free of wire controls');
  }
  return `${utf8ByteLength(value)}:${value}`;
}

/** Length prefixes prevent profile/instance/entity delimiter collisions. */
export function hostQualifiedCacheKey(
  identity: HostQualifiedIdentity,
  namespace: string,
  entityId: string,
): string {
  return [
    'agent-deck-host-v1',
    identity.profileId,
    identity.topology,
    identity.instanceId,
    identity.authoritativeCoreId,
    identity.authoritativeCoreGeneration === null
      ? 'generation:none'
      : `generation:${identity.authoritativeCoreGeneration}`,
    namespace,
    entityId,
  ]
    .map(encodePart)
    .join('|');
}
