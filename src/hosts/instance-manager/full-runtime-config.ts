import { posix } from 'node:path';

import {
  atomicWrite,
  ensureDirectoryChain,
  requireCanonicalDirectory,
  requireCanonicalFile,
} from './artifacts';
import type { InstanceManagerContext } from './context';
import { fullVolumeNames } from './paths';
import { sha256 } from './serialization';
import type { FileIdentity, PodmanVolumeInspection } from './types';
import { fail, requireOwnedFile, sameIdentity } from './validation';

function stateLabels(instanceId: string): Readonly<Record<string, string>> {
  return {
    'io.agent-deck.instance': instanceId,
    'io.agent-deck.managed-by': 'instance-manager',
    'io.agent-deck.purpose': 'state',
    'io.agent-deck.topology': 'full',
  };
}

function exactLabels(
  observed: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const left = Object.keys(observed).sort();
  const right = Object.keys(expected).sort();
  return left.length === right.length &&
    left.every((key, index) => key === right[index] && observed[key] === expected[key]);
}

async function stateVolume(context: InstanceManagerContext, instanceId: string): Promise<{
  readonly volume: PodmanVolumeInspection;
  readonly dataPath: string;
  readonly rootIdentity: FileIdentity;
  readonly configPath: string;
}> {
  const name = fullVolumeNames(instanceId)[0];
  const volume = await context.ports.podman.inspectVolume(
    name,
    context.limits.commandTimeoutMs,
  );
  if (!volume || !exactLabels(volume.labels, stateLabels(instanceId))) {
    fail('tampered', 'Full state volume identity or labels are not exact');
  }
  const dataPath = await context.ports.podman.resolveVolumeDataPathExact(
    volume,
    context.limits.commandTimeoutMs,
  );
  const root = await requireCanonicalDirectory(
    context.ports.fileSystem,
    dataPath,
    'Full state volume data directory',
  );
  if (root.uid !== context.serviceUid || (root.mode & 0o022) !== 0) {
    fail('tampered', 'Full state volume data directory has unsafe ownership or mode');
  }
  return {
    volume,
    dataPath,
    rootIdentity: root,
    configPath: posix.join(
      dataPath,
      'config',
      'agent-deck',
      'instances',
      instanceId,
      'config.json',
    ),
  };
}

async function assertStableVolume(
  context: InstanceManagerContext,
  expected: Awaited<ReturnType<typeof stateVolume>>,
): Promise<void> {
  const repeated = await context.ports.podman.resolveVolumeDataPathExact(
    expected.volume,
    context.limits.commandTimeoutMs,
  );
  if (repeated !== expected.dataPath) {
    fail('tampered', 'Full state volume data path changed during config access');
  }
  const root = await requireCanonicalDirectory(
    context.ports.fileSystem,
    repeated,
    'Full state volume data directory',
  );
  if (
    !sameIdentity(root, expected.rootIdentity) ||
    root.mode !== expected.rootIdentity.mode ||
    (root.mode & 0o022) !== 0
  ) {
    fail('tampered', 'Full state volume data directory changed during config access');
  }
}

async function currentConfig(
  context: InstanceManagerContext,
  configPath: string,
): Promise<{ readonly identity: FileIdentity; readonly digest: string } | null> {
  if (!(await context.ports.fileSystem.lstat(configPath))) return null;
  const file = await requireCanonicalFile(
    context.ports.fileSystem,
    configPath,
    context.limits.maxArtifactBytes,
    'Full runtime config mirror',
  );
  requireOwnedFile(file.identity, context.serviceUid, 0o600, 'Full runtime config mirror');
  return { identity: file.identity, digest: sha256(file.bytes) };
}

export async function verifyFullRuntimeConfig(
  context: InstanceManagerContext,
  instanceId: string,
  expectedSha256: string,
): Promise<void> {
  const state = await stateVolume(context, instanceId);
  const current = await currentConfig(context, state.configPath);
  if (!current || current.digest !== expectedSha256) {
    fail('tampered', 'Full runtime config mirror does not match the instance record');
  }
  await assertStableVolume(context, state);
}

export async function installFullRuntimeConfig(
  context: InstanceManagerContext,
  instanceId: string,
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<void> {
  const state = await stateVolume(context, instanceId);
  const parent = posix.dirname(state.configPath);
  await ensureDirectoryChain(
    context.ports.fileSystem,
    state.dataPath,
    parent,
    [],
    context.serviceUid,
  );
  await assertStableVolume(context, state);
  const current = await currentConfig(context, state.configPath);
  if (
    expectedSha256 === null
      ? current !== null
      : !current || current.digest !== expectedSha256
  ) {
    fail('tampered', 'Full runtime config mirror changed before atomic installation');
  }
  await assertStableVolume(context, state);
  const installed = await atomicWrite(
    context.ports.fileSystem,
    state.configPath,
    bytes,
    0o600,
    current?.identity ?? null,
    context.ports.ids.nextId(),
  );
  requireOwnedFile(installed, context.serviceUid, 0o600, 'installed Full runtime config mirror');
  const nextDigest = sha256(bytes);
  const verified = await currentConfig(context, state.configPath);
  if (!verified || verified.digest !== nextDigest) {
    fail('recovery_required', 'Full runtime config mirror could not be verified after install');
  }
  await assertStableVolume(context, state);
}

export async function restoreFullRuntimeConfig(
  context: InstanceManagerContext,
  instanceId: string,
  previousBytes: Uint8Array,
  previousSha256: string,
  attemptedSha256: string,
): Promise<void> {
  const state = await stateVolume(context, instanceId);
  const current = await currentConfig(context, state.configPath);
  if (current?.digest === previousSha256) {
    await assertStableVolume(context, state);
    return;
  }
  if (current?.digest !== attemptedSha256) {
    fail('recovery_required', 'Full runtime config mirror is neither cutover version');
  }
  await assertStableVolume(context, state);
  await installFullRuntimeConfig(
    context,
    instanceId,
    previousBytes,
    attemptedSha256,
  );
}
