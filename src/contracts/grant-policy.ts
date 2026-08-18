import {
  AccessSurface,
  type AccessContext,
  type AccessSurface as Surface,
  type AuthenticatedClientAccessContext,
} from './access';
import { CORE_METHOD_METADATA, type CoreMethod } from './methods';
import type { DeploymentTopology } from './topology';

export const REMOTE_OWNER_PRODUCT_POLICY = 'Remote Owner Product v1';
export const REMOTE_OWNER_PRODUCT_POLICY_VERSION = 1;
export const REMOTE_OWNER_PRODUCT_POLICY_REVISION = 1;

/** Fixed product operations currently reachable through Remote Desktop. */
export const REMOTE_OWNER_PRODUCT_V1_METHODS = Object.freeze([
  'session.console.list',
  'session.console.get',
  'session.console.capabilities',
  'workspace.directory.list',
  'workspace.directory.create',
  'session.archive',
  'session.unarchive',
  'session.reactivate',
  'session.delete',
  'project.list',
  'session.console.create',
  'session.presentation.list',
  'session.messages.list',
  'session.outgoing.list',
  'session.outgoing.remove',
  'session.history',
  'session.events.list',
  'session.summaries.list',
  'session.file-changes.list',
  'session.file-changes.get',
  'session.file-changes.final-diff',
  'session.assets.image-chunk.read',
  'session.tasks.list',
  'usage.tokens.get',
  'usage.providers.get',
  'node.configuration.get',
  'node.hook.projection.get',
  'node.assets.catalog.list',
  'node.assets.content',
  'node.assets.convention',
  'issues.list',
  'issues.get',
  'issues.update',
  'issues.soft-delete',
  'issues.undelete',
  'issues.resolve-in-new-session',
  'session.send',
  'session.interrupt',
  'session.steer',
  'pending.list',
  'pending.index.list',
  'pending.respond',
  'plan.review.start',
  'plan.review.ask',
  'plan.review.feedback',
  'session.runtime.get',
  'session.runtime.update',
  'session.context.get',
  'session.input.capabilities',
  'session.handoff.preview',
  'session.handoff.commit',
] as const satisfies readonly CoreMethod[]);

export const CHANNEL_INTERNAL_METHODS = Object.freeze({
  [AccessSurface.Desktop]: Object.freeze([
    'desktop.broker.next',
    'desktop.broker.respond',
  ] as const satisfies readonly CoreMethod[]),
  [AccessSurface.Feishu]: Object.freeze([
    'subscription.set',
  ] as const satisfies readonly CoreMethod[]),
});

export const UNGRANTED_REMOTE_CORE_METHODS = Object.freeze([
  'system.health',
] as const satisfies readonly CoreMethod[]);

export interface RemoteOwnerGrantClaim {
  readonly policy: typeof REMOTE_OWNER_PRODUCT_POLICY;
  readonly policyVersion: typeof REMOTE_OWNER_PRODUCT_POLICY_VERSION;
  readonly policyRevision: number;
  readonly productMethods: readonly CoreMethod[];
  readonly channelMethods: readonly CoreMethod[];
}

export interface RemoteOwnerGrantWireClaim {
  readonly policy: typeof REMOTE_OWNER_PRODUCT_POLICY;
  readonly policyVersion: typeof REMOTE_OWNER_PRODUCT_POLICY_VERSION;
  readonly policyRevision: number;
  readonly productBits: string;
  readonly channelBits: string;
}

function exactMethods(
  value: unknown,
  allowed: readonly CoreMethod[],
): readonly CoreMethod[] | null {
  if (!Array.isArray(value) || value.length > allowed.length) return null;
  const methods: CoreMethod[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isCoreMethod(entry) || !allowed.includes(entry)) return null;
    methods.push(entry);
  }
  return new Set(methods).size === methods.length ? methods : null;
}

export function assertRemoteOwnerGrantClaim(
  value: unknown,
): asserts value is RemoteOwnerGrantClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Remote owner grant claim must be an object');
  }
  const claim = value as Partial<RemoteOwnerGrantClaim>;
  const keys = Object.keys(value).sort();
  const expected = [
    'channelMethods', 'policy', 'policyRevision', 'policyVersion', 'productMethods',
  ];
  const productMethods = exactMethods(claim.productMethods, REMOTE_OWNER_PRODUCT_V1_METHODS);
  const internal = Object.freeze([
    ...CHANNEL_INTERNAL_METHODS.desktop,
    ...CHANNEL_INTERNAL_METHODS.feishu,
  ] as CoreMethod[]);
  const channelMethods = exactMethods(claim.channelMethods, internal);
  if (
    keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
    claim.policy !== REMOTE_OWNER_PRODUCT_POLICY ||
    claim.policyVersion !== REMOTE_OWNER_PRODUCT_POLICY_VERSION ||
    !Number.isSafeInteger(claim.policyRevision) || (claim.policyRevision ?? 0) <= 0 ||
    productMethods === null || channelMethods === null
  ) {
    throw new TypeError('Remote owner grant claim is invalid');
  }
}

export function copyRemoteOwnerGrantClaim(value: RemoteOwnerGrantClaim): RemoteOwnerGrantClaim {
  assertRemoteOwnerGrantClaim(value);
  return Object.freeze({
    policy: value.policy,
    policyVersion: value.policyVersion,
    policyRevision: value.policyRevision,
    productMethods: Object.freeze([...value.productMethods]),
    channelMethods: Object.freeze([...value.channelMethods]),
  });
}

export function assertRemoteOwnerGrantForSurface(
  value: RemoteOwnerGrantClaim,
  surface: 'desktop' | 'feishu',
): void {
  assertRemoteOwnerGrantClaim(value);
  const expected = CHANNEL_INTERNAL_METHODS[surface];
  if (
    value.channelMethods.length !== expected.length ||
    value.channelMethods.some((method) => !expected.includes(method as never))
  ) {
    throw new TypeError('Remote owner channel grant does not match its surface');
  }
}

function encodeMethodBits(methods: readonly CoreMethod[]): string {
  const directory = allCoreMethods();
  const bits = new Array<number>(Math.ceil(directory.length / 4)).fill(0);
  for (const method of methods) {
    const index = directory.indexOf(method);
    if (index < 0) throw new TypeError(`Unknown Core method in grant: ${method}`);
    bits[Math.floor(index / 4)]! |= 1 << (index % 4);
  }
  return bits.map((value) => value.toString(16)).join('');
}

function decodeMethodBits(value: unknown): readonly CoreMethod[] {
  const directory = allCoreMethods();
  const expectedLength = Math.ceil(directory.length / 4);
  if (typeof value !== 'string' || value.length !== expectedLength || !/^[0-9a-f]+$/.test(value)) {
    throw new TypeError('Remote owner method bits are invalid');
  }
  const methods: CoreMethod[] = [];
  for (let index = 0; index < value.length * 4; index += 1) {
    const digit = Number.parseInt(value[Math.floor(index / 4)]!, 16);
    if ((digit & (1 << (index % 4))) === 0) continue;
    const method = directory[index];
    if (!method) throw new TypeError('Remote owner method bits exceed the Core directory');
    methods.push(method);
  }
  return Object.freeze(methods);
}

export function encodeRemoteOwnerGrantClaim(
  value: RemoteOwnerGrantClaim,
): RemoteOwnerGrantWireClaim {
  assertRemoteOwnerGrantClaim(value);
  return Object.freeze({
    policy: value.policy,
    policyVersion: value.policyVersion,
    policyRevision: value.policyRevision,
    productBits: encodeMethodBits(value.productMethods),
    channelBits: encodeMethodBits(value.channelMethods),
  });
}

export function decodeRemoteOwnerGrantClaim(
  value: unknown,
): RemoteOwnerGrantClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Remote owner wire grant must be an object');
  }
  const wire = value as Partial<RemoteOwnerGrantWireClaim>;
  const keys = Object.keys(value).sort();
  const expected = ['channelBits', 'policy', 'policyRevision', 'policyVersion', 'productBits'];
  if (
    keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
    wire.policy !== REMOTE_OWNER_PRODUCT_POLICY ||
    wire.policyVersion !== REMOTE_OWNER_PRODUCT_POLICY_VERSION ||
    !Number.isSafeInteger(wire.policyRevision) || (wire.policyRevision ?? 0) <= 0
  ) {
    throw new TypeError('Remote owner wire grant is invalid');
  }
  const claim: RemoteOwnerGrantClaim = {
    policy: REMOTE_OWNER_PRODUCT_POLICY,
    policyVersion: REMOTE_OWNER_PRODUCT_POLICY_VERSION,
    policyRevision: wire.policyRevision!,
    productMethods: decodeMethodBits(wire.productBits),
    channelMethods: decodeMethodBits(wire.channelBits),
  };
  assertRemoteOwnerGrantClaim(claim);
  return copyRemoteOwnerGrantClaim(claim);
}

function clientSurface(surface: Surface): surface is 'desktop' | 'feishu' {
  return surface === AccessSurface.Desktop || surface === AccessSurface.Feishu;
}

/** Called only by Server admission, never by Core dispatch. */
export function issueRemoteOwnerGrantClaim(
  surface: Surface,
  policyRevision = REMOTE_OWNER_PRODUCT_POLICY_REVISION,
): RemoteOwnerGrantClaim {
  if (!clientSurface(surface) || !Number.isSafeInteger(policyRevision) || policyRevision <= 0) {
    throw new TypeError('Remote owner grant claim input is invalid');
  }
  return Object.freeze({
    policy: REMOTE_OWNER_PRODUCT_POLICY,
    policyVersion: REMOTE_OWNER_PRODUCT_POLICY_VERSION,
    policyRevision,
    productMethods: REMOTE_OWNER_PRODUCT_V1_METHODS,
    channelMethods: CHANNEL_INTERNAL_METHODS[surface],
  });
}

export interface IssueRemoteOwnerAccessContextInput {
  readonly topology: Exclude<DeploymentTopology, 'standalone'>;
  readonly instanceId: string;
  readonly clientId: string;
  readonly connectionScope: string;
  readonly surface: 'desktop' | 'feishu';
  readonly policyRevision?: number;
}

/** Server-side convenience for constructing a transport-bound immutable access claim. */
export function issueRemoteOwnerAccessContext(
  input: IssueRemoteOwnerAccessContextInput,
): AuthenticatedClientAccessContext {
  const common = {
    kind: 'authenticated-client' as const,
    topology: input.topology,
    instanceId: input.instanceId,
    clientId: input.clientId,
    connectionScope: input.connectionScope,
    authority: 'owner-equivalent' as const,
    grant: issueRemoteOwnerGrantClaim(input.surface, input.policyRevision),
  };
  return input.surface === AccessSurface.Desktop
    ? Object.freeze({ ...common, transport: 'ssh' as const, surface: AccessSurface.Desktop })
    : Object.freeze({ ...common, transport: 'feishu' as const, surface: AccessSurface.Feishu });
}

export function isCoreMethod(value: string): value is CoreMethod {
  return Object.prototype.hasOwnProperty.call(CORE_METHOD_METADATA, value);
}

export function isCoreMethodGranted(
  access: AccessContext,
  method: string,
): method is CoreMethod {
  if (!isCoreMethod(method)) return false;
  if (access.kind === 'standalone') return true;
  if (access.kind === 'relay-worker') return false;
  return access.grant.productMethods.includes(method) ||
    access.grant.channelMethods.includes(method);
}

export function allCoreMethods(): readonly CoreMethod[] {
  return Object.freeze(Object.keys(CORE_METHOD_METADATA) as CoreMethod[]);
}
