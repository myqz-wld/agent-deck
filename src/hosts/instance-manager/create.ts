import { atomicWrite, cleanupCreatedPaths, ensureDirectoryChain, type CreatedPath } from './artifacts';
import type { InstanceManagerContext } from './context';
import { fullVolumeNames, resolveInstancePaths } from './paths';
import { advanceJournal, clearJournal, newJournal, writeJournal, type StoredJournal } from './journal';
import { validateTemplateAndRendered } from './preflight';
import { encodeRecord } from './serialization';
import type {
  CreateInstanceRequest,
  InstanceRecord,
  InstanceSummary,
  PodmanVolumeInspection,
} from './types';
import {
  assertPlainJson,
  fail,
  validateFullResources,
  validateImage,
  validateInstanceId,
  validateTopology,
  validateVersion,
  requireOwnedFile,
  InstanceManagerError,
} from './validation';
import { prepareVersionArtifacts, stageVersion } from './version-artifacts';

function volumeLabels(instanceId: string, purpose: string): Readonly<Record<string, string>> {
  return {
    'io.agent-deck.instance': instanceId,
    'io.agent-deck.managed-by': 'instance-manager',
    'io.agent-deck.purpose': purpose,
    'io.agent-deck.topology': 'full',
  };
}

function exactLabels(
  observed: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const observedKeys = Object.keys(observed).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    observedKeys.length === expectedKeys.length &&
    observedKeys.every((key, index) => key === expectedKeys[index] && observed[key] === expected[key])
  );
}

async function validateImageAvailable(context: InstanceManagerContext, image: string): Promise<void> {
  const digest = validateImage(image);
  const inspection = await context.ports.podman.inspectImage(image, context.limits.commandTimeoutMs);
  if (!inspection || inspection.reference !== image || inspection.digest !== `sha256:${digest}`) {
    fail('tampered', 'Podman image inspection did not return the exact pinned image');
  }
}

export async function assertCreateNamespaceAbsent(
  context: InstanceManagerContext,
  request: Pick<CreateInstanceRequest, 'topology' | 'instanceId'>,
): Promise<void> {
  const paths = resolveInstancePaths(context.roots, request.topology, request.instanceId);
  if (await context.ports.fileSystem.lstat(paths.journalPath)) {
    fail('recovery_required', 'a durable operation journal requires reconciliation before create');
  }
  const candidates = new Set([
    paths.configDirectory,
    paths.stateDirectory,
    paths.runtimeDirectory,
    paths.unitPath,
    paths.metadataDirectory,
    paths.backupDirectory,
    paths.evidenceDirectory,
    paths.cutoverEvidenceDirectory,
  ].filter((path): path is string => path !== null));
  for (const path of candidates) {
    if (await context.ports.fileSystem.lstat(path)) fail('already_exists', `instance namespace already exists: ${path}`);
  }
  if (request.topology === 'full') {
    for (const name of fullVolumeNames(request.instanceId)) {
      if (await context.ports.podman.inspectVolume(name, context.limits.commandTimeoutMs)) {
        fail('already_exists', `scoped volume already exists: ${name}`);
      }
    }
  }
}

async function createFullVolumes(
  context: InstanceManagerContext,
  instanceId: string,
): Promise<PodmanVolumeInspection[]> {
  const created: PodmanVolumeInspection[] = [];
  try {
    for (const name of fullVolumeNames(instanceId)) {
      if (await context.ports.podman.inspectVolume(name, context.limits.commandTimeoutMs)) {
        fail('already_exists', `scoped volume already exists: ${name}`);
      }
      const purpose = name.slice(name.lastIndexOf('-') + 1);
      const labels = volumeLabels(instanceId, purpose);
      const volume = await context.ports.podman.createVolume(
        name,
        labels,
        context.limits.commandTimeoutMs,
      );
      if (volume.name === name && volume.identity) created.push(volume);
      if (volume.name !== name || !volume.identity || !exactLabels(volume.labels, labels)) {
        fail('tampered', 'Podman returned a mismatched created volume identity');
      }
    }
    return created;
  } catch (error) {
    await cleanupVolumes(context, created);
    throw error;
  }
}

async function cleanupVolumes(
  context: InstanceManagerContext,
  created: readonly PodmanVolumeInspection[],
): Promise<void> {
  for (const volume of [...created].reverse()) {
    const observed = await context.ports.podman.inspectVolume(
      volume.name,
      context.limits.commandTimeoutMs,
    );
    if (
      observed &&
      observed.identity === volume.identity &&
      exactLabels(observed.labels, volume.labels)
    ) {
      await context.ports.podman.removeVolumeExact(observed, context.limits.commandTimeoutMs);
    } else if (observed) fail('recovery_required', 'created volume identity changed during cleanup');
  }
}

async function cleanupCreate(
  context: InstanceManagerContext,
  paths: ReturnType<typeof resolveInstancePaths>,
  journal: StoredJournal,
  createdPaths: readonly CreatedPath[],
  createdVolumes: readonly PodmanVolumeInspection[],
  primary: unknown,
): Promise<never> {
  const failures: unknown[] = [primary];
  try { await cleanupCreatedPaths(context.ports.fileSystem, createdPaths); } catch (error) { failures.push(error); }
  try { await cleanupVolumes(context, createdVolumes); } catch (error) { failures.push(error); }
  if (createdPaths.some((entry) => entry.path === paths.unitPath)) {
    try { await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) {
    try { await clearJournal(context, paths, journal); } catch (error) { failures.push(error); }
  }
  if (failures.length > 1) {
    throw new InstanceManagerError('cleanup_failed', 'create failed and durable cleanup is incomplete', { cause: new AggregateError(failures) });
  }
  throw primary;
}

export async function createInstance(
  context: InstanceManagerContext,
  request: CreateInstanceRequest,
): Promise<InstanceSummary> {
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
  const prepared = await prepareVersionArtifacts({
    topology: request.topology, paths, roots: context.roots, ports: context.ports,
    image: request.image, runtimeConfig: request.runtimeConfig, fullResources: request.fullResources,
    maxArtifactBytes: context.limits.maxArtifactBytes, expectedUid: context.serviceUid,
    trustedArtifactUid: context.trustedArtifactUid,
  });
  let journal = await writeJournal(context, paths, newJournal({
    operationId: context.ports.ids.nextId(), operation: 'create', topology: request.topology,
    instanceId: request.instanceId, expectedGeneration: 0, expectedVersion: null, phase: 'intent',
    target: { version: request.version, image: request.image, unitSha256: prepared.unitSha256, configSha256: prepared.configSha256, record: null },
    previousRecord: null, createdPaths: [], createdVolumes: [], removal: null,
  }), null);

  const createdPaths: CreatedPath[] = [];
  let createdVolumes: PodmanVolumeInspection[] = [];
  try {
    await ensureDirectoryChain(
      context.ports.fileSystem,
      context.roots.metadataRoot,
      paths.metadataDirectory,
      createdPaths,
      context.serviceUid,
    );
    await ensureDirectoryChain(
      context.ports.fileSystem,
      context.roots.serviceHome,
      paths.configDirectory,
      createdPaths,
      context.serviceUid,
    );
    if (paths.stateDirectory) {
      await ensureDirectoryChain(
        context.ports.fileSystem,
        context.roots.serviceHome,
        paths.stateDirectory,
        createdPaths,
        context.serviceUid,
      );
    }
    await ensureDirectoryChain(
      context.ports.fileSystem,
      context.roots.runtimeRoot,
      paths.runtimeDirectory,
      createdPaths,
      context.serviceUid,
    );
    const staged = await stageVersion({
      topology: request.topology,
      paths,
      roots: context.roots,
      ports: context.ports,
      version: request.version,
      image: request.image,
      runtimeConfig: request.runtimeConfig,
      fullResources: request.fullResources,
      maxArtifactBytes: context.limits.maxArtifactBytes,
      expectedUid: context.serviceUid,
      trustedArtifactUid: context.trustedArtifactUid,
    });
    createdPaths.push(...staged.created);
    const now = context.ports.clock.nowMs();
    const record: InstanceRecord = {
      schemaVersion: 1, topology: request.topology, instanceId: request.instanceId,
      generation: 1, currentVersion: request.version, previousVersion: null,
      versions: [staged.version], createdAtMs: now, updatedAtMs: now,
    };
    journal = await advanceJournal(context, paths, journal, {
      phase: 'prepared', createdPaths: [...createdPaths],
      target: { ...journal.journal.target as NonNullable<typeof journal.journal.target>, record },
    });
    await validateTemplateAndRendered({
      topology: request.topology,
      paths,
      renderedArtifactPath: staged.version.unitBackupPath,
      context,
    });
    if (request.topology === 'full') {
      createdVolumes = await createFullVolumes(context, request.instanceId);
      journal = await advanceJournal(context, paths, journal, { createdVolumes: [...createdVolumes] });
    }
    journal = await advanceJournal(context, paths, journal, { phase: 'config_installing' });
    const configIdentity = await atomicWrite(
      context.ports.fileSystem,
      paths.configFile,
      staged.configBytes,
      0o600,
      null,
      context.ports.ids.nextId(),
    );
    createdPaths.push({ path: paths.configFile, identity: configIdentity, kind: 'file' });
    journal = await advanceJournal(context, paths, journal, { phase: 'config_installed', createdPaths: [...createdPaths] });
    requireOwnedFile(configIdentity, context.serviceUid, 0o600, 'installed runtime config');
    journal = await advanceJournal(context, paths, journal, { phase: 'unit_installing' });
    const unitIdentity = await atomicWrite(
      context.ports.fileSystem,
      paths.unitPath,
      staged.unitBytes,
      0o444,
      null,
      context.ports.ids.nextId(),
    );
    createdPaths.push({ path: paths.unitPath, identity: unitIdentity, kind: 'file' });
    journal = await advanceJournal(context, paths, journal, { phase: 'unit_installed', createdPaths: [...createdPaths] });
    requireOwnedFile(unitIdentity, context.serviceUid, 0o444, 'installed Quadlet');
    journal = await advanceJournal(context, paths, journal, { phase: 'record_installing' });
    const recordIdentity = await atomicWrite(
      context.ports.fileSystem,
      paths.recordPath,
      encodeRecord(record),
      0o600,
      null,
      context.ports.ids.nextId(),
    );
    createdPaths.push({ path: paths.recordPath, identity: recordIdentity, kind: 'file' });
    journal = await advanceJournal(context, paths, journal, { phase: 'record_committed', createdPaths: [...createdPaths] });
    requireOwnedFile(recordIdentity, context.serviceUid, 0o600, 'instance record');
    await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs);
    await clearJournal(context, paths, journal);
    return {
      topology: request.topology,
      instanceId: request.instanceId,
      generation: 1,
      currentVersion: request.version,
      image: request.image,
      unitName: paths.unitName,
      unitPath: paths.unitPath,
    };
  } catch (error) {
    return cleanupCreate(context, paths, journal, createdPaths, createdVolumes, error);
  }
}

export { exactLabels, validateImageAvailable, volumeLabels };
