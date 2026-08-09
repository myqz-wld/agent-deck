import { posix } from 'node:path';

import {
  AppliancePolicyError,
  createImmutableOuterCeiling,
  type ApplianceMount,
  type ApplianceNetworkCeiling,
  type ApplianceOuterCeiling,
  type ApplianceResourceLimits,
} from './policy';

export interface ApplianceControlSocket {
  readonly path: string;
  readonly mode: 0o600;
  readonly published: false;
}

export interface ApplianceHealthCheck {
  readonly command: readonly string[];
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly retries: number;
}

export interface FullApplianceManifest {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly image: string;
  readonly rootless: true;
  readonly readOnlyRootFilesystem: true;
  readonly privileged: false;
  readonly hostNetwork: false;
  readonly noNewPrivileges: true;
  readonly droppedCapabilities: readonly string[];
  readonly addedCapabilities: readonly string[];
  readonly devices: readonly string[];
  readonly publishedPorts: readonly string[];
  readonly mounts: readonly ApplianceMount[];
  readonly resources: ApplianceResourceLimits;
  readonly network: ApplianceNetworkCeiling & { readonly name: string };
  readonly controlSocket: ApplianceControlSocket;
  readonly healthCheck: ApplianceHealthCheck;
}

const IMAGE_DIGEST_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const NUL_CHARACTER = '\u0000';

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppliancePolicyError(field, 'must be a positive safe integer');
  }
}

function assertManifestResources(
  resources: ApplianceResourceLimits,
  ceiling: ApplianceResourceLimits,
): void {
  if (!Number.isFinite(resources.cpuCores) || resources.cpuCores <= 0) {
    throw new AppliancePolicyError('manifest.resources.cpuCores', 'must be positive');
  }
  for (const name of ['memoryBytes', 'pids', 'storageBytes', 'logBytes'] as const) {
    assertPositiveInteger(resources[name], `manifest.resources.${name}`);
  }
  if (resources.logBytes > resources.storageBytes) {
    throw new AppliancePolicyError(
      'manifest.resources.logBytes',
      'cannot exceed manifest storage quota',
    );
  }
  for (const name of Object.keys(ceiling) as (keyof ApplianceResourceLimits)[]) {
    if (resources[name] > ceiling[name]) {
      throw new AppliancePolicyError(
        `manifest.resources.${name}`,
        'cannot exceed immutable outer ceiling',
      );
    }
  }
}

function mountFingerprint(mount: ApplianceMount): string {
  return JSON.stringify([
    mount.id,
    mount.kind,
    mount.source,
    mount.target,
    mount.access,
    mount.purpose,
  ]);
}

function assertExactMounts(
  manifestMounts: readonly ApplianceMount[],
  ceilingMounts: readonly ApplianceMount[],
): void {
  if (manifestMounts.length !== ceilingMounts.length) {
    throw new AppliancePolicyError(
      'manifest.mounts',
      'must exactly match the immutable outer ceiling mount set',
    );
  }
  const expected = new Set(ceilingMounts.map(mountFingerprint));
  const observed = new Set<string>();
  for (const [index, mount] of manifestMounts.entries()) {
    const fingerprint = mountFingerprint(mount);
    if (!expected.has(fingerprint)) {
      throw new AppliancePolicyError(
        `manifest.mounts[${index}]`,
        'is absent from or broader than the immutable outer ceiling',
      );
    }
    if (observed.has(fingerprint)) {
      throw new AppliancePolicyError(
        `manifest.mounts[${index}]`,
        'duplicates an immutable outer ceiling mount',
      );
    }
    observed.add(fingerprint);
  }
}

function assertNetwork(
  network: FullApplianceManifest['network'],
  ceiling: ApplianceNetworkCeiling,
  instanceId: string,
): void {
  const protocols = new Set(network.publicEgress);
  if (network.name !== `agent-deck-${instanceId}-egress`) {
    throw new AppliancePolicyError(
      'manifest.network.name',
      'must be an instance-namespaced private egress network',
    );
  }
  if (
    network.enforcement !== 'verified-egress-gateway' ||
    network.denyInbound !== ceiling.denyInbound ||
    network.denyHostLoopback !== ceiling.denyHostLoopback ||
    network.denyPrivateNetworks !== ceiling.denyPrivateNetworks ||
    network.denyCloudMetadata !== ceiling.denyCloudMetadata ||
    protocols.size !== ceiling.publicEgress.length ||
    [...protocols].some((protocol) => !ceiling.publicEgress.includes(protocol))
  ) {
    throw new AppliancePolicyError(
      'manifest.network',
      'must preserve the verified public DNS/HTTP(S)-only outer network ceiling',
    );
  }
}

function assertSocket(
  socket: ApplianceControlSocket,
  mounts: readonly ApplianceMount[],
  instanceId: string,
): void {
  const expectedPath = `/run/agent-deck/${instanceId}/agent-deckd.sock`;
  if (
    !posix.isAbsolute(socket.path) ||
    posix.normalize(socket.path) !== socket.path ||
    socket.path !== expectedPath
  ) {
    throw new AppliancePolicyError(
      'manifest.controlSocket.path',
      'must be the private daemon socket inside /run/agent-deck',
    );
  }
  if (socket.mode !== 0o600 || socket.published !== false) {
    throw new AppliancePolicyError(
      'manifest.controlSocket',
      'must be mode 0600 and never published',
    );
  }
  if (
    !mounts.some(
      (mount) =>
        mount.purpose === 'daemon-socket' &&
        posix.relative(mount.target, socket.path).startsWith(`${instanceId}/`),
    )
  ) {
    throw new AppliancePolicyError(
      'manifest.controlSocket.path',
      'must live in the explicit daemon-socket volume',
    );
  }
}

function assertHealthCheck(check: ApplianceHealthCheck, socketPath: string): void {
  if (
    check.command.length < 2 ||
    check.command.some((argument) => !argument || argument.includes(NUL_CHARACTER)) ||
    !check.command.includes(socketPath)
  ) {
    throw new AppliancePolicyError(
      'manifest.healthCheck.command',
      'must be argv-based and probe the private daemon socket',
    );
  }
  assertPositiveInteger(check.intervalSeconds, 'manifest.healthCheck.intervalSeconds');
  assertPositiveInteger(check.timeoutSeconds, 'manifest.healthCheck.timeoutSeconds');
  assertPositiveInteger(check.retries, 'manifest.healthCheck.retries');
  if (check.timeoutSeconds >= check.intervalSeconds) {
    throw new AppliancePolicyError(
      'manifest.healthCheck.timeoutSeconds',
      'must be shorter than intervalSeconds',
    );
  }
}

export function validateFullApplianceManifest(
  manifest: FullApplianceManifest,
  outerCeiling: ApplianceOuterCeiling,
): void {
  const ceiling = createImmutableOuterCeiling(outerCeiling);
  if (manifest.schemaVersion !== 1 || manifest.instanceId !== ceiling.instanceId) {
    throw new AppliancePolicyError(
      'manifest.instanceId',
      'must match the versioned immutable outer ceiling',
    );
  }
  if (manifest.image.includes(NUL_CHARACTER) || !IMAGE_DIGEST_PATTERN.test(manifest.image)) {
    throw new AppliancePolicyError(
      'manifest.image',
      'must be an immutable sha256-pinned image reference',
    );
  }
  if (
    manifest.rootless !== true ||
    manifest.readOnlyRootFilesystem !== true ||
    manifest.privileged !== false ||
    manifest.hostNetwork !== false ||
    manifest.noNewPrivileges !== true
  ) {
    throw new AppliancePolicyError(
      'manifest.security',
      'requires rootless, read-only, no-new-privileges, non-host, non-privileged execution',
    );
  }
  if (
    manifest.droppedCapabilities.length !== 1 ||
    manifest.droppedCapabilities[0] !== 'ALL' ||
    manifest.addedCapabilities.length !== 0
  ) {
    throw new AppliancePolicyError(
      'manifest.capabilities',
      'must drop ALL capabilities and add none',
    );
  }
  if (manifest.devices.length !== 0) {
    throw new AppliancePolicyError('manifest.devices', 'device passthrough is forbidden');
  }
  if (manifest.publishedPorts.length !== 0) {
    throw new AppliancePolicyError(
      'manifest.publishedPorts',
      'control or application port publication is forbidden',
    );
  }
  assertExactMounts(manifest.mounts, ceiling.mounts);
  assertManifestResources(manifest.resources, ceiling.resources);
  assertNetwork(manifest.network, ceiling.network, ceiling.instanceId);
  assertSocket(manifest.controlSocket, manifest.mounts, manifest.instanceId);
  assertHealthCheck(manifest.healthCheck, manifest.controlSocket.path);
}
