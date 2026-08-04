import { timingSafeEqual } from 'node:crypto';

import { requireOwnedDirectory, snapshotTreeForRemoval } from './artifacts';
import type { InstanceManagerContext } from './context';
import { advanceJournal, clearJournal, newJournal, writeJournal } from './journal';
import { assertVersionFence, loadInstance, type LoadedInstance } from './instance-reader';
import { assertExactUnitStatus, summary } from './lifecycle';
import { fullVolumeNames } from './paths';
import { canonicalJson, sha256 } from './serialization';
import type {
  FileIdentity,
  ExactTreeSnapshot,
  RemoveInstanceRequest,
  RemovePlan,
  RemovePlanRequest,
  PodmanVolumeInspection,
} from './types';
import { exactLabels, volumeLabels } from './create';
import { fail, InstanceManagerError, sameIdentity, validateVersion } from './validation';

function confirmationToken(
  loaded: LoadedInstance,
  deleteData: boolean,
  keepBackups: boolean,
): string {
  const digest = sha256(
    canonicalJson({
      action: 'remove',
      topology: loaded.record.topology,
      instanceId: loaded.record.instanceId,
      generation: loaded.record.generation,
      currentVersion: loaded.record.currentVersion,
      unitPath: loaded.paths.unitPath,
      deleteData,
      keepBackups,
    }),
  );
  return `remove:${loaded.record.topology}:${loaded.record.instanceId}:${loaded.record.generation}:${digest}`;
}

function tokenEquals(observed: string, expected: string): boolean {
  if (typeof observed !== 'string' || Buffer.byteLength(observed, 'utf8') > 192 || !/^[a-z0-9:-]+$/.test(observed)) return false;
  const left = Buffer.from(observed);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function requireAbsentAndInactive(context: InstanceManagerContext, loaded: LoadedInstance): Promise<void> {
  const status = await context.ports.systemd.statusUserUnit(loaded.paths.unitName, context.limits.lifecycleTimeoutMs);
  if (
    status.unitName !== loaded.paths.unitName || status.fragmentPath !== '' ||
    status.loadState !== 'not-found' ||
    !['active', 'activating', 'deactivating', 'failed', 'inactive'].includes(status.activeState) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(status.subState)
  ) {
    fail('tampered', 'systemd did not report the exact removed user unit namespace');
  }
  if (status.activeState !== 'inactive') {
    try {
      await context.ports.systemd.stopUserUnit(loaded.paths.unitName, context.limits.lifecycleTimeoutMs);
    } catch (cleanup) {
      throw new InstanceManagerError('cleanup_failed', 'removed unit became active and could not be stopped', { cause: cleanup });
    }
    fail('not_stopped', 'removed unit became active; data removal was refused');
  }
}

async function requireStopped(
  context: InstanceManagerContext,
  loaded: LoadedInstance,
): Promise<void> {
  const status = await context.ports.systemd.statusUserUnit(
    loaded.paths.unitName,
    context.limits.lifecycleTimeoutMs,
  );
  assertExactUnitStatus(loaded, status);
  if (status.activeState !== 'inactive') fail('not_stopped', 'remove requires an inactive exact user unit');
}

function dataPaths(loaded: LoadedInstance): readonly string[] {
  if (loaded.record.topology === 'full') {
    return [
      loaded.paths.configDirectory,
      loaded.paths.runtimeDirectory,
      ...fullVolumeNames(loaded.record.instanceId).map((name) => `podman-volume:${name}`),
      loaded.paths.cutoverEvidenceDirectory,
    ];
  }
  if (!loaded.paths.stateDirectory) fail('tampered', 'relay state path is missing');
  return [loaded.paths.configDirectory, loaded.paths.stateDirectory, loaded.paths.runtimeDirectory, loaded.paths.evidenceDirectory, loaded.paths.cutoverEvidenceDirectory];
}

export async function planRemove(
  context: InstanceManagerContext,
  request: RemovePlanRequest,
): Promise<RemovePlan> {
  if (typeof request.deleteData !== 'boolean' || typeof request.keepBackups !== 'boolean') {
    fail('invalid_input', 'remove choices must explicitly set deleteData and keepBackups');
  }
  const loaded = await loadInstance({
    selector: request,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  await requireStopped(context, loaded);
  return {
    ...summary(loaded),
    confirmationToken: confirmationToken(loaded, request.deleteData, request.keepBackups),
    dataPaths: dataPaths(loaded),
    backupPath: loaded.paths.backupDirectory,
    deleteData: request.deleteData,
    keepBackups: request.keepBackups,
  };
}

async function recheck(
  context: InstanceManagerContext,
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const observed = await context.ports.fileSystem.lstat(path);
  if (!observed || !sameIdentity(observed, expected)) {
    fail('tampered', `resource identity changed before removal: ${path}`);
  }
}

async function inspectFullVolumes(
  context: InstanceManagerContext,
  instanceId: string,
): Promise<readonly PodmanVolumeInspection[]> {
  const volumes: PodmanVolumeInspection[] = [];
  for (const name of fullVolumeNames(instanceId)) {
    const volume = await context.ports.podman.inspectVolume(name, context.limits.commandTimeoutMs);
    const purpose = name.slice(name.lastIndexOf('-') + 1);
    const labels = volumeLabels(instanceId, purpose);
    if (!volume || volume.name !== name || !exactLabels(volume.labels, labels)) {
      fail('tampered', `scoped volume identity is missing or changed: ${name}`);
    }
    volumes.push(volume);
  }
  return volumes;
}

async function removeFullVolumes(
  context: InstanceManagerContext,
  expected: readonly PodmanVolumeInspection[],
): Promise<void> {
  for (const volume of expected) {
    const observed = await context.ports.podman.inspectVolume(
      volume.name,
      context.limits.commandTimeoutMs,
    );
    if (
      !observed ||
      observed.identity !== volume.identity ||
      !exactLabels(observed.labels, volume.labels)
    ) {
      fail('tampered', `scoped volume identity changed before removal: ${volume.name}`);
    }
    await context.ports.podman.removeVolumeExact(observed, context.limits.commandTimeoutMs);
  }
}

export async function removeInstance(
  context: InstanceManagerContext,
  request: RemoveInstanceRequest,
): Promise<void> {
  validateVersion(request.expectedVersion, 'expectedVersion');
  if (typeof request.deleteData !== 'boolean' || typeof request.keepBackups !== 'boolean') {
    fail('invalid_input', 'remove choices must explicitly set deleteData and keepBackups');
  }
  const loaded = await loadInstance({
    selector: request,
    roots: context.roots,
    ports: context.ports,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    serviceUid: context.serviceUid,
  });
  assertVersionFence(loaded, request.expectedGeneration, request.expectedVersion);
  await requireStopped(context, loaded);
  const expectedToken = confirmationToken(loaded, request.deleteData, request.keepBackups);
  if (!tokenEquals(request.confirmationToken, expectedToken)) {
    fail('conflict', 'remove confirmation token does not match this exact instance and choice set');
  }

  await recheck(context, loaded.paths.recordPath, loaded.recordIdentity);
  await recheck(context, loaded.paths.unitPath, loaded.unitIdentity);
  await recheck(context, loaded.paths.configFile, loaded.configIdentity);

  let configTree: ExactTreeSnapshot | null = null;
  let stateTree: ExactTreeSnapshot | null = null;
  let runtimeTree: ExactTreeSnapshot | null = null;
  let fullVolumes: readonly PodmanVolumeInspection[] = [];
  const externalEvidenceTrees: ExactTreeSnapshot[] = [];
  const metadataTree = await snapshotTreeForRemoval(context.ports.fileSystem, loaded.paths.metadataDirectory);
  let backupTree: ExactTreeSnapshot | null = null;
  if (!request.keepBackups) {
    backupTree = await snapshotTreeForRemoval(context.ports.fileSystem, loaded.paths.backupDirectory);
  }
  if (request.deleteData) {
    configTree = await snapshotTreeForRemoval(context.ports.fileSystem, loaded.paths.configDirectory);
    runtimeTree = await snapshotTreeForRemoval(context.ports.fileSystem, loaded.paths.runtimeDirectory);
    if (loaded.paths.stateDirectory) {
      stateTree = await snapshotTreeForRemoval(context.ports.fileSystem, loaded.paths.stateDirectory);
    }
    if (loaded.record.topology === 'full') {
      fullVolumes = await inspectFullVolumes(context, loaded.record.instanceId);
    }
  }
  for (const path of new Set([
    ...(loaded.record.topology === 'relay' ? [loaded.paths.evidenceDirectory] : []),
    loaded.paths.cutoverEvidenceDirectory,
  ])) {
    if (await context.ports.fileSystem.lstat(path)) {
      await requireOwnedDirectory(context.ports.fileSystem, path, context.trustedRootUid, 0o555, 'external instance evidence directory');
      const snapshot = await snapshotTreeForRemoval(context.ports.fileSystem, path);
      if (snapshot.entries.some((entry) => entry.identity.uid !== context.trustedRootUid || (entry.identity.mode & 0o777) !== (entry.identity.kind === 'directory' ? 0o555 : 0o444))) {
        fail('tampered', 'external evidence tree contains an untrusted owner or mode');
      }
      externalEvidenceTrees.push(snapshot);
    }
  }

  const trees = [
    ...(request.deleteData ? [stateTree, runtimeTree, configTree] : []),
    ...(!request.keepBackups ? [backupTree] : []),
    ...externalEvidenceTrees,
    metadataTree,
  ].filter((tree): tree is ExactTreeSnapshot => tree !== null);
  let journal = await writeJournal(context, loaded.paths, newJournal({
    operationId: context.ports.ids.nextId(), operation: 'remove', topology: loaded.record.topology,
    instanceId: loaded.record.instanceId, expectedGeneration: loaded.record.generation,
    expectedVersion: loaded.record.currentVersion, phase: 'prepared', target: null,
    previousRecord: loaded.record,
    createdPaths: [{ path: loaded.paths.unitPath, identity: loaded.unitIdentity, kind: 'file' }],
    createdVolumes: [], removal: { deleteData: request.deleteData, keepBackups: request.keepBackups, trees, volumes: fullVolumes },
  }), null);
  try {
    await requireStopped(context, loaded);
    journal = await advanceJournal(context, loaded.paths, journal, { phase: 'unit_unlinking' });
    await requireStopped(context, loaded);
    await context.ports.fileSystem.removeFileExact(loaded.paths.unitPath, loaded.unitIdentity);
    journal = await advanceJournal(context, loaded.paths, journal, { phase: 'unit_unlinked' });
    journal = await advanceJournal(context, loaded.paths, journal, { phase: 'reloading' });
    await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs);
    await requireAbsentAndInactive(context, loaded);
    journal = await advanceJournal(context, loaded.paths, journal, { phase: 'deleting_data' });
    if (request.deleteData) {
      if (loaded.record.topology === 'full') await removeFullVolumes(context, fullVolumes);
      if (stateTree) await context.ports.fileSystem.removeTreeExact(stateTree);
      if (runtimeTree) await context.ports.fileSystem.removeTreeExact(runtimeTree);
      if (configTree) await context.ports.fileSystem.removeTreeExact(configTree);
    }
    if (backupTree) await context.ports.fileSystem.removeTreeExact(backupTree);
    for (const tree of externalEvidenceTrees) await context.ports.fileSystem.removeTreeExact(tree);
    await context.ports.fileSystem.removeTreeExact(metadataTree);
    journal = await advanceJournal(context, loaded.paths, journal, { phase: 'complete' });
    await requireAbsentAndInactive(context, loaded);
    for (const tree of trees) {
      if (await context.ports.fileSystem.lstat(tree.rootPath)) fail('recovery_required', 'removed tree reappeared before completion');
    }
    for (const volume of fullVolumes) {
      if (await context.ports.podman.inspectVolume(volume.name, context.limits.commandTimeoutMs)) fail('recovery_required', 'removed volume reappeared before completion');
    }
    await clearJournal(context, loaded.paths, journal);
  } catch (error) {
    if (error instanceof InstanceManagerError) throw error;
    throw new InstanceManagerError('recovery_required', 'remove was interrupted; exact tombstone evidence is preserved', { cause: error });
  }
}
