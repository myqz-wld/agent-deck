import type { InstanceManagerContext } from './context';
import { evidencePaths } from './evidence';
import { assertVersionFence, loadInstance } from './instance-reader';
import { fullVolumeNames, resolveInstancePaths } from './paths';
import type {
  CreateInstanceRequest,
  InstanceOperationPlan,
  InstanceSelector,
  PlannedAction,
  UpgradeInstanceRequest,
  VersionFence,
} from './types';
import {
  assertPlainJson,
  checkedNextGeneration,
  fail,
  validateFullResources,
  validateImage,
  validateInstanceId,
  validateTopology,
  validateVersion,
} from './validation';
import { assertCreateNamespaceAbsent, validateImageAvailable } from './create';
import { readVersionArtifacts } from './version-artifacts';

function fromPaths(
  action: PlannedAction,
  paths: ReturnType<typeof resolveInstancePaths>,
  generation: number | null,
  version: string | null,
  destructive = false,
): InstanceOperationPlan {
  return {
    action,
    topology: paths.topology,
    instanceId: paths.instanceId,
    generation,
    version,
    unitName: paths.unitName,
    unitPath: paths.unitPath,
    configPath: paths.configFile,
    statePath: paths.stateDirectory,
    runtimePath: paths.runtimeDirectory,
    hostControlSocketPath: paths.hostControlSocketPath,
    containerControlSocketPath: paths.containerControlSocketPath,
    metadataPath: paths.metadataDirectory,
    backupPath: paths.backupDirectory,
    evidencePaths: generation === null || version === null ? evidencePaths(paths.topology, paths) : evidencePaths(paths.topology, paths, generation, version),
    volumeNames: paths.topology === 'full' ? fullVolumeNames(paths.instanceId) : [],
    destructive,
  };
}

export function planList(): InstanceOperationPlan {
  return {
    action: 'list',
    topology: null,
    instanceId: null,
    generation: null,
    version: null,
    unitName: null,
    unitPath: null,
    configPath: null,
    statePath: null,
    runtimePath: null,
    hostControlSocketPath: null,
    containerControlSocketPath: null,
    metadataPath: null,
    backupPath: null,
    evidencePaths: [],
    volumeNames: [],
    destructive: false,
  };
}

export async function planCreate(
  context: InstanceManagerContext,
  request: CreateInstanceRequest,
): Promise<InstanceOperationPlan> {
  validateTopology(request.topology);
  validateInstanceId(request.instanceId);
  validateVersion(request.version);
  validateImage(request.image);
  assertPlainJson(request.runtimeConfig);
  if (request.topology === 'full') validateFullResources(request.fullResources);
  else if (request.fullResources !== undefined) fail('invalid_input', 'relay cannot accept fullResources');
  const paths = resolveInstancePaths(context.roots, request.topology, request.instanceId);
  await assertCreateNamespaceAbsent(context, request);
  await validateImageAvailable(context, request.image);
  return fromPaths('create', paths, 1, request.version);
}

export async function planExisting(
  context: InstanceManagerContext,
  action: 'start' | 'stop' | 'status',
  selector: InstanceSelector,
): Promise<InstanceOperationPlan> {
  const loaded = await loadInstance({
    selector,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  return fromPaths(action, loaded.paths, loaded.record.generation, loaded.record.currentVersion);
}

export async function planUpgrade(
  context: InstanceManagerContext,
  request: UpgradeInstanceRequest,
): Promise<InstanceOperationPlan> {
  validateVersion(request.expectedVersion, 'expectedVersion');
  validateVersion(request.nextVersion, 'nextVersion');
  validateImage(request.nextImage);
  assertPlainJson(request.runtimeConfig);
  if (request.topology === 'full') validateFullResources(request.fullResources);
  else if (request.fullResources !== undefined) fail('invalid_input', 'relay cannot accept fullResources');
  const loaded = await loadInstance({
    selector: request,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  assertVersionFence(loaded, request.expectedGeneration, request.expectedVersion);
  if (loaded.record.versions.some((version) => version.version === request.nextVersion)) {
    fail('conflict', 'nextVersion is already recoverable');
  }
  if (loaded.record.versions.length >= 64) fail('conflict', 'recoverable version limit reached');
  await validateImageAvailable(context, request.nextImage);
  return fromPaths(
    'upgrade',
    loaded.paths,
    checkedNextGeneration(loaded.record.generation),
    request.nextVersion,
    true,
  );
}

export async function planRollback(
  context: InstanceManagerContext,
  request: VersionFence,
): Promise<InstanceOperationPlan> {
  validateVersion(request.expectedVersion, 'expectedVersion');
  const loaded = await loadInstance({
    selector: request,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  assertVersionFence(loaded, request.expectedGeneration, request.expectedVersion);
  if (!loaded.record.previousVersion) fail('conflict', 'instance has no recoverable previous version');
  const target = loaded.record.versions.find(
    (version) => version.version === loaded.record.previousVersion,
  );
  if (!target) fail('tampered', 'previous version record is missing');
  await readVersionArtifacts({
    ports: context.ports,
    version: target,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    expectedUid: context.serviceUid,
  });
  return fromPaths(
    'rollback',
    loaded.paths,
    checkedNextGeneration(loaded.record.generation),
    target.version,
    true,
  );
}
