import { posix } from 'node:path';

import { assertInstanceId } from '@hosts/daemon/instance-paths';

export type ApplianceMountAccess = 'read-only' | 'read-write';
export type ApplianceMountKind = 'bind' | 'named-volume' | 'tmpfs';
export type ApplianceMountPurpose =
  | 'browser-profile'
  | 'daemon-socket'
  | 'secret'
  | 'scratch'
  | 'state'
  | 'workspace';
export type PublicEgressProtocol = 'dns' | 'http' | 'https';

export interface ApplianceMount {
  readonly id: string;
  readonly kind: ApplianceMountKind;
  readonly source: string | null;
  readonly target: string;
  readonly access: ApplianceMountAccess;
  readonly purpose: ApplianceMountPurpose;
}

export interface ApplianceResourceLimits {
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly pids: number;
  readonly storageBytes: number;
  readonly logBytes: number;
}

export interface ApplianceNetworkCeiling {
  readonly publicEgress: readonly PublicEgressProtocol[];
  readonly denyInbound: true;
  readonly denyHostLoopback: true;
  readonly denyPrivateNetworks: true;
  readonly denyCloudMetadata: true;
  readonly enforcement: 'verified-egress-gateway';
}

export interface ApplianceOuterCeiling {
  readonly instanceId: string;
  readonly mounts: readonly ApplianceMount[];
  readonly allowedBindSourceRoots: readonly string[];
  readonly resources: ApplianceResourceLimits;
  readonly network: ApplianceNetworkCeiling;
  readonly allowDevices: false;
  readonly allowPublishedPorts: false;
  readonly allowEngineSocket: false;
  readonly allowHostNetwork: false;
  readonly allowPrivileged: false;
}

export interface SessionPolicyRequest {
  readonly mounts: readonly Pick<ApplianceMount, 'access' | 'target'>[];
  readonly publicEgress: readonly PublicEgressProtocol[];
  readonly resources?: Partial<ApplianceResourceLimits>;
}

export interface EffectiveSessionPolicy {
  readonly mounts: readonly Pick<ApplianceMount, 'access' | 'target'>[];
  readonly publicEgress: readonly PublicEgressProtocol[];
  readonly resources: ApplianceResourceLimits;
  readonly allowDevices: false;
  readonly allowPublishedPorts: false;
  readonly allowEngineSocket: false;
  readonly allowHostNetwork: false;
  readonly allowPrivileged: false;
}

export class AppliancePolicyError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'AppliancePolicyError';
  }
}

const ALLOWED_TARGETS = new Map<ApplianceMountPurpose, string>([
  ['state', '/var/lib/agent-deck'],
  ['workspace', '/workspaces'],
  ['daemon-socket', '/run/agent-deck'],
  ['browser-profile', '/var/lib/agent-deck-browser'],
  ['secret', '/run/secrets'],
  ['scratch', '/tmp'],
]);
const REQUIRED_PURPOSES: readonly ApplianceMountPurpose[] = [
  'state',
  'workspace',
  'daemon-socket',
  'browser-profile',
];
const PUBLIC_EGRESS = new Set<PublicEgressProtocol>(['dns', 'http', 'https']);
const MOUNT_ACCESSES = new Set<ApplianceMountAccess>(['read-only', 'read-write']);
const MOUNT_KINDS = new Set<ApplianceMountKind>(['bind', 'named-volume', 'tmpfs']);
const MOUNT_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const NAMED_VOLUME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const RESOURCE_FIELDS = new Set<keyof ApplianceResourceLimits>([
  'cpuCores',
  'memoryBytes',
  'pids',
  'storageBytes',
  'logBytes',
]);
const NUL_CHARACTER = '\u0000';

function cloneAndFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) cloneAndFreeze(nested);
  return Object.freeze(value);
}

function assertLinuxPath(path: string, field: string): void {
  if (
    !path ||
    path.includes(NUL_CHARACTER) ||
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path
  ) {
    throw new AppliancePolicyError(field, 'must be a normalized absolute Linux path');
  }
}

function isForbiddenHostPath(path: string): boolean {
  return (
    path === '/' ||
    /^(?:\/home|\/root|\/Users)(?:\/|$)/.test(path) ||
    /^\/dev(?:\/|$)/.test(path) ||
    /\/(?:docker|podman|containerd)(?:\.sock|\/[^/]*\.sock)$/.test(path) ||
    /\/(?:docker|podman|containerd)\.sock$/.test(path)
  );
}

function isInside(path: string, root: string): boolean {
  const relative = posix.relative(root, path);
  return relative === '' || (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative));
}

function assertResources(resources: ApplianceResourceLimits, field: string): void {
  if (!Number.isFinite(resources.cpuCores) || resources.cpuCores <= 0) {
    throw new AppliancePolicyError(`${field}.cpuCores`, 'must be positive');
  }
  for (const name of ['memoryBytes', 'pids', 'storageBytes', 'logBytes'] as const) {
    const value = resources[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AppliancePolicyError(`${field}.${name}`, 'must be a positive safe integer');
    }
  }
  if (resources.logBytes > resources.storageBytes) {
    throw new AppliancePolicyError(`${field}.logBytes`, 'cannot exceed storageBytes');
  }
}

function assertNetwork(network: ApplianceNetworkCeiling): void {
  const protocols = new Set(network.publicEgress);
  if (
    protocols.size !== PUBLIC_EGRESS.size ||
    [...PUBLIC_EGRESS].some((protocol) => !protocols.has(protocol))
  ) {
    throw new AppliancePolicyError(
      'network.publicEgress',
      'must explicitly contain public DNS, HTTP, and HTTPS only',
    );
  }
  if (
    network.denyInbound !== true ||
    network.denyHostLoopback !== true ||
    network.denyPrivateNetworks !== true ||
    network.denyCloudMetadata !== true ||
    network.enforcement !== 'verified-egress-gateway'
  ) {
    throw new AppliancePolicyError(
      'network',
      'must fail closed through a verified egress gateway with inbound/host/LAN/metadata denial',
    );
  }
}

function assertBindRoots(instanceId: string, roots: readonly string[]): void {
  const seen = new Set<string>();
  for (const [index, root] of roots.entries()) {
    const field = `allowedBindSourceRoots[${index}]`;
    assertLinuxPath(root, field);
    if (isForbiddenHostPath(root)) {
      throw new AppliancePolicyError(field, 'cannot be a host root/home/device/engine path');
    }
    if (!root.split('/').includes(instanceId)) {
      throw new AppliancePolicyError(field, 'must be namespaced by the immutable instanceId');
    }
    if (seen.has(root)) throw new AppliancePolicyError(field, 'must be unique');
    seen.add(root);
  }
}

function assertMount(
  instanceId: string,
  mount: ApplianceMount,
  index: number,
  bindRoots: readonly string[],
): void {
  const field = `mounts[${index}]`;
  if (!MOUNT_ID_PATTERN.test(mount.id)) {
    throw new AppliancePolicyError(`${field}.id`, 'must be a stable lowercase label');
  }
  if (!MOUNT_KINDS.has(mount.kind)) {
    throw new AppliancePolicyError(`${field}.kind`, 'must be bind, named-volume, or tmpfs');
  }
  if (!MOUNT_ACCESSES.has(mount.access)) {
    throw new AppliancePolicyError(`${field}.access`, 'must be read-only or read-write');
  }
  if (!ALLOWED_TARGETS.has(mount.purpose)) {
    throw new AppliancePolicyError(`${field}.purpose`, 'must be a known mount purpose');
  }
  assertLinuxPath(mount.target, `${field}.target`);
  if (ALLOWED_TARGETS.get(mount.purpose) !== mount.target) {
    throw new AppliancePolicyError(
      `${field}.target`,
      `must equal ${ALLOWED_TARGETS.get(mount.purpose) ?? 'a known target'} for ${mount.purpose}`,
    );
  }
  if (mount.purpose === 'secret' && mount.access !== 'read-only') {
    throw new AppliancePolicyError(`${field}.access`, 'secret mounts must be read-only');
  }
  if (mount.kind === 'tmpfs') {
    if (mount.source !== null || mount.purpose !== 'scratch') {
      throw new AppliancePolicyError(field, 'tmpfs is allowed only for source-less scratch');
    }
    return;
  }
  if (!mount.source) throw new AppliancePolicyError(`${field}.source`, 'is required');
  if (mount.kind === 'named-volume') {
    if (!NAMED_VOLUME_PATTERN.test(mount.source)) {
      throw new AppliancePolicyError(`${field}.source`, 'must be a valid named volume');
    }
    if (!mount.source.startsWith(`agent-deck-${instanceId}-`)) {
      throw new AppliancePolicyError(`${field}.source`, 'must be namespaced by instanceId');
    }
    return;
  }
  assertLinuxPath(mount.source, `${field}.source`);
  if (isForbiddenHostPath(mount.source)) {
    throw new AppliancePolicyError(
      `${field}.source`,
      'cannot expose host root/home/device/container-engine control',
    );
  }
  if (!bindRoots.some((root) => isInside(mount.source as string, root))) {
    throw new AppliancePolicyError(`${field}.source`, 'is outside the explicit instance bind roots');
  }
}

function validateCeiling(ceiling: ApplianceOuterCeiling): void {
  assertInstanceId(ceiling.instanceId);
  assertBindRoots(ceiling.instanceId, ceiling.allowedBindSourceRoots);
  assertResources(ceiling.resources, 'resources');
  assertNetwork(ceiling.network);
  if (
    ceiling.allowDevices !== false ||
    ceiling.allowPublishedPorts !== false ||
    ceiling.allowEngineSocket !== false ||
    ceiling.allowHostNetwork !== false ||
    ceiling.allowPrivileged !== false
  ) {
    throw new AppliancePolicyError('outerCeiling', 'host/device/engine/network privileges must be false');
  }

  const ids = new Set<string>();
  const targets = new Set<string>();
  const purposes = new Set<ApplianceMountPurpose>();
  for (const [index, mount] of ceiling.mounts.entries()) {
    assertMount(ceiling.instanceId, mount, index, ceiling.allowedBindSourceRoots);
    if (ids.has(mount.id)) {
      throw new AppliancePolicyError(`mounts[${index}].id`, 'must be unique');
    }
    if (targets.has(mount.target)) {
      throw new AppliancePolicyError(`mounts[${index}].target`, 'must be unique');
    }
    ids.add(mount.id);
    targets.add(mount.target);
    purposes.add(mount.purpose);
  }
  for (const purpose of REQUIRED_PURPOSES) {
    if (!purposes.has(purpose)) {
      throw new AppliancePolicyError('mounts', `missing required ${purpose} mount`);
    }
  }
}

export function createImmutableOuterCeiling(
  input: ApplianceOuterCeiling,
): ApplianceOuterCeiling {
  const copy: ApplianceOuterCeiling = {
    ...input,
    mounts: input.mounts.map((mount) => ({ ...mount })),
    allowedBindSourceRoots: [...input.allowedBindSourceRoots],
    resources: { ...input.resources },
    network: { ...input.network, publicEgress: [...input.network.publicEgress] },
  };
  validateCeiling(copy);
  return cloneAndFreeze(copy);
}

function narrowedResources(
  ceiling: ApplianceResourceLimits,
  requested: Partial<ApplianceResourceLimits> = {},
): ApplianceResourceLimits {
  for (const name of Object.keys(requested)) {
    if (!RESOURCE_FIELDS.has(name as keyof ApplianceResourceLimits)) {
      throw new AppliancePolicyError(`session.resources.${name}`, 'is not a recognized limit');
    }
  }
  const result: ApplianceResourceLimits = { ...ceiling, ...requested };
  assertResources(result, 'session.resources');
  for (const name of Object.keys(ceiling) as (keyof ApplianceResourceLimits)[]) {
    if (result[name] > ceiling[name]) {
      throw new AppliancePolicyError(`session.resources.${name}`, 'cannot exceed outer ceiling');
    }
  }
  return result;
}

export function narrowSessionPolicy(
  ceiling: ApplianceOuterCeiling,
  requested: SessionPolicyRequest,
): EffectiveSessionPolicy {
  validateCeiling(ceiling);
  const ceilingMounts = new Map(ceiling.mounts.map((mount) => [mount.target, mount]));
  const targets = new Set<string>();
  const mounts = requested.mounts.map((mount, index) => {
    if (!MOUNT_ACCESSES.has(mount.access)) {
      throw new AppliancePolicyError(
        `session.mounts[${index}].access`,
        'must be read-only or read-write',
      );
    }
    const outer = ceilingMounts.get(mount.target);
    if (!outer) {
      throw new AppliancePolicyError(`session.mounts[${index}]`, 'is absent from outer ceiling');
    }
    if (targets.has(mount.target)) {
      throw new AppliancePolicyError(`session.mounts[${index}]`, 'duplicates a mount target');
    }
    targets.add(mount.target);
    if (outer.access === 'read-only' && mount.access === 'read-write') {
      throw new AppliancePolicyError(`session.mounts[${index}].access`, 'widens read-only access');
    }
    return { target: mount.target, access: mount.access };
  });

  const outerProtocols = new Set(ceiling.network.publicEgress);
  const requestedProtocols = new Set(requested.publicEgress);
  if (
    requestedProtocols.size !== requested.publicEgress.length ||
    [...requestedProtocols].some((protocol) => !outerProtocols.has(protocol))
  ) {
    throw new AppliancePolicyError('session.publicEgress', 'must be a unique subset of the ceiling');
  }

  return cloneAndFreeze({
    mounts,
    publicEgress: [...requested.publicEgress],
    resources: narrowedResources(ceiling.resources, requested.resources),
    allowDevices: false,
    allowPublishedPorts: false,
    allowEngineSocket: false,
    allowHostNetwork: false,
    allowPrivileged: false,
  });
}
