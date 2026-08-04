import { atomicWrite, cleanupCreatedPaths } from './artifacts';
import type { InstanceManagerContext } from './context';
import { advanceJournal, clearJournal, newJournal, writeJournal, type StoredJournal } from './journal';
import { evidencePaths, revalidateEvidence, validateStartEvidence } from './evidence';
import { assertVersionFence, loadInstance, revalidateLoadedArtifacts, type LoadedInstance } from './instance-reader';
import { assertExactUnitStatus } from './lifecycle';
import { runStartPreflight, validateTemplateAndRendered } from './preflight';
import { encodeRecord } from './serialization';
import type {
  InstanceRecord,
  InstanceStatus,
  ManagedVersion,
  UpgradeInstanceRequest,
  VersionFence,
} from './types';
import {
  assertPlainJson,
  checkedNextGeneration,
  fail,
  InstanceManagerError,
  requireOwnedFile,
  validateFullResources,
  validateImage,
  validateVersion,
} from './validation';
import { prepareVersionArtifacts, readVersionArtifacts, stageVersion, type StagedVersion } from './version-artifacts';
import { validateImageAvailable } from './create';

class UnrecoveredCutoverError extends InstanceManagerError {
  constructor(primary: unknown, cleanup: unknown) {
    super('cleanup_failed', 'cutover failed and the previous version could not be recovered safely', { cause: new AggregateError([primary, cleanup]) });
    this.name = 'UnrecoveredCutoverError';
  }
}

interface JournalRef { stored: StoredJournal }

async function requireHealthy(
  context: InstanceManagerContext,
  loaded: LoadedInstance,
  version: ManagedVersion,
): Promise<void> {
  const container = await context.ports.podman.inspectContainer(
    loaded.paths.containerName,
    context.limits.healthTimeoutMs,
  );
  if (
    !container ||
    container.name !== loaded.paths.containerName ||
    container.image !== version.image ||
    !container.running ||
    container.health !== 'healthy'
  ) {
    fail('health_failed', 'cutover container did not become healthy with the expected image');
  }
  const unit = await context.ports.systemd.statusUserUnit(
    loaded.paths.unitName,
    context.limits.lifecycleTimeoutMs,
  );
  assertExactUnitStatus(loaded, unit);
  if (unit.activeState !== 'active') fail('health_failed', 'cutover user unit is not active');
}

async function validateCutoverTarget(
  context: InstanceManagerContext,
  loaded: LoadedInstance,
  target: ManagedVersion,
  generation: number,
): Promise<Awaited<ReturnType<typeof validateStartEvidence>>> {
  await validateImageAvailable(context, target.image);
  const snapshots = await validateStartEvidence({
    topology: loaded.record.topology,
    paths: loaded.paths,
    generation,
    version: target,
    fileSystem: context.ports.fileSystem,
    clock: context.ports.clock,
    serviceUid: context.serviceUid,
    trustedRootUid: context.trustedRootUid,
    maxAgeMs: context.limits.maxEvidenceAgeMs,
  });
  const evidence = evidencePaths(loaded.record.topology, loaded.paths);
  await runStartPreflight({
    topology: loaded.record.topology,
    paths: loaded.paths,
    renderedArtifactPath: target.unitBackupPath,
    egressEvidencePath: evidence[0],
    quotaEvidencePath: evidence[1],
    context,
  });
  return snapshots;
}

async function recoverPrevious(
  context: InstanceManagerContext,
  loaded: LoadedInstance,
  oldUnitBytes: Uint8Array,
  oldConfigBytes: Uint8Array,
  installedUnitIdentity: Awaited<ReturnType<typeof atomicWrite>> | null,
  installedConfigIdentity: Awaited<ReturnType<typeof atomicWrite>> | null,
): Promise<void> {
  await context.ports.systemd.stopUserUnit(
    loaded.paths.unitName,
    context.limits.lifecycleTimeoutMs,
  );
  if (installedUnitIdentity) {
    const restoredUnit = await atomicWrite(
      context.ports.fileSystem,
      loaded.paths.unitPath,
      oldUnitBytes,
      0o444,
      installedUnitIdentity,
      context.ports.ids.nextId(),
    );
    requireOwnedFile(restoredUnit, context.serviceUid, 0o444, 'restored Quadlet');
  }
  if (installedConfigIdentity) {
    const restoredConfig = await atomicWrite(
      context.ports.fileSystem,
      loaded.paths.configFile,
      oldConfigBytes,
      0o600,
      installedConfigIdentity,
      context.ports.ids.nextId(),
    );
    requireOwnedFile(restoredConfig, context.serviceUid, 0o600, 'restored runtime config');
  }
  await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs);
  const evidenceSnapshots = await validateStartEvidence({
    topology: loaded.record.topology, paths: loaded.paths, generation: loaded.record.generation,
    version: loaded.current, fileSystem: context.ports.fileSystem, clock: context.ports.clock,
    serviceUid: context.serviceUid, trustedRootUid: context.trustedRootUid,
    maxAgeMs: context.limits.maxEvidenceAgeMs,
  });
  const legacyEvidence = evidencePaths(loaded.record.topology, loaded.paths);
  await runStartPreflight({
    topology: loaded.record.topology, paths: loaded.paths,
    renderedArtifactPath: loaded.current.unitBackupPath,
    egressEvidencePath: legacyEvidence[0], quotaEvidencePath: legacyEvidence[1], context,
  });
  await revalidateEvidence(context.ports.fileSystem, evidenceSnapshots, context.ports.clock, context.limits.maxEvidenceAgeMs);
  await revalidateLoadedArtifacts({ loaded, ports: context.ports, maxArtifactBytes: context.limits.maxArtifactBytes, serviceUid: context.serviceUid });
  await context.ports.systemd.startUserUnit(
    loaded.paths.unitName,
    context.limits.lifecycleTimeoutMs,
  );
  await requireHealthy(context, loaded, loaded.current);
}

async function cutover(
  context: InstanceManagerContext,
  loaded: LoadedInstance,
  target: ManagedVersion,
  nextRecord: InstanceRecord,
  journal: JournalRef,
): Promise<InstanceStatus> {
  const before = await context.ports.systemd.statusUserUnit(
    loaded.paths.unitName,
    context.limits.lifecycleTimeoutMs,
  );
  assertExactUnitStatus(loaded, before);
  if (before.activeState !== 'active') fail('conflict', 'upgrade and rollback require a running instance');
  const targetArtifacts = await readVersionArtifacts({
    ports: context.ports,
    version: target,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    expectedUid: context.serviceUid,
  });
  const oldArtifacts = await readVersionArtifacts({
    ports: context.ports,
    version: loaded.current,
    maxArtifactBytes: context.limits.maxArtifactBytes,
    expectedUid: context.serviceUid,
  });
  const evidenceSnapshots = await validateCutoverTarget(context, loaded, target, nextRecord.generation);

  let installedConfigIdentity: Awaited<ReturnType<typeof atomicWrite>> | null = null;
  let installedUnitIdentity: Awaited<ReturnType<typeof atomicWrite>> | null = null;
  let stopped = false;
  let recordCommitted = false;
  try {
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'stopping' });
    await context.ports.systemd.stopUserUnit(
      loaded.paths.unitName,
      context.limits.lifecycleTimeoutMs,
    );
    stopped = true;
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'stopped' });
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'config_installing' });
    installedConfigIdentity = await atomicWrite(
      context.ports.fileSystem,
      loaded.paths.configFile,
      targetArtifacts.configBytes,
      0o600,
      loaded.configIdentity,
      context.ports.ids.nextId(),
    );
    requireOwnedFile(
      installedConfigIdentity,
      context.serviceUid,
      0o600,
      'cutover runtime config',
    );
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'config_installed' });
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'unit_installing' });
    installedUnitIdentity = await atomicWrite(
      context.ports.fileSystem,
      loaded.paths.unitPath,
      targetArtifacts.unitBytes,
      0o444,
      loaded.unitIdentity,
      context.ports.ids.nextId(),
    );
    requireOwnedFile(installedUnitIdentity, context.serviceUid, 0o444, 'cutover Quadlet');
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'unit_installed' });
    await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs);
    await revalidateEvidence(context.ports.fileSystem, evidenceSnapshots, context.ports.clock, context.limits.maxEvidenceAgeMs);
    await revalidateLoadedArtifacts({ loaded, version: target, ports: context.ports, maxArtifactBytes: context.limits.maxArtifactBytes, serviceUid: context.serviceUid });
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'starting' });
    await context.ports.systemd.startUserUnit(
      loaded.paths.unitName,
      context.limits.lifecycleTimeoutMs,
    );
    await requireHealthy(context, loaded, target);
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'healthy' });
    const systemd = await context.ports.systemd.statusUserUnit(
      loaded.paths.unitName,
      context.limits.lifecycleTimeoutMs,
    );
    assertExactUnitStatus(loaded, systemd);
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'record_installing' });
    const recordIdentity = await atomicWrite(
      context.ports.fileSystem,
      loaded.paths.recordPath,
      encodeRecord(nextRecord),
      0o600,
      loaded.recordIdentity,
      context.ports.ids.nextId(),
    );
    recordCommitted = true;
    requireOwnedFile(recordIdentity, context.serviceUid, 0o600, 'committed instance record');
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'committed' });
    await clearJournal(context, loaded.paths, journal.stored);
    return {
      topology: nextRecord.topology,
      instanceId: nextRecord.instanceId,
      generation: nextRecord.generation,
      currentVersion: nextRecord.currentVersion,
      image: target.image,
      unitName: loaded.paths.unitName,
      unitPath: loaded.paths.unitPath,
      systemd,
    };
  } catch (error) {
    if (recordCommitted) throw error;
    if (stopped) {
      try {
        await recoverPrevious(
          context,
          loaded,
          oldArtifacts.unitBytes,
          oldArtifacts.configBytes,
          installedUnitIdentity,
          installedConfigIdentity,
        );
        journal.stored = await advanceJournal(context, loaded.paths, journal.stored, { phase: 'prepared' });
      } catch (recovery) {
        throw new UnrecoveredCutoverError(error, recovery);
      }
    }
    throw error;
  }
}

export async function upgradeInstance(
  context: InstanceManagerContext,
  request: UpgradeInstanceRequest,
): Promise<InstanceStatus> {
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
    fail('conflict', 'nextVersion is already present in the recoverable version set');
  }
  if (loaded.record.versions.length >= 64) fail('conflict', 'recoverable version limit reached');
  await validateImageAvailable(context, request.nextImage);
  const stageInput = {
    topology: request.topology, paths: loaded.paths, roots: context.roots, ports: context.ports,
    image: request.nextImage, runtimeConfig: request.runtimeConfig, fullResources: request.fullResources,
    maxArtifactBytes: context.limits.maxArtifactBytes, expectedUid: context.serviceUid,
    trustedArtifactUid: context.trustedArtifactUid,
  } as const;
  const prepared = await prepareVersionArtifacts(stageInput);
  const journal: JournalRef = { stored: await writeJournal(context, loaded.paths, newJournal({
    operationId: context.ports.ids.nextId(), operation: 'upgrade', topology: request.topology,
    instanceId: request.instanceId, expectedGeneration: loaded.record.generation,
    expectedVersion: loaded.record.currentVersion, phase: 'intent',
    target: { version: request.nextVersion, image: request.nextImage, unitSha256: prepared.unitSha256, configSha256: prepared.configSha256, record: null },
    previousRecord: loaded.record, createdPaths: [], createdVolumes: [], removal: null,
  }), null) };
  let staged: StagedVersion | null = null;
  try {
    staged = await stageVersion({ ...stageInput, version: request.nextVersion });
    await validateTemplateAndRendered({
      topology: request.topology,
      paths: loaded.paths,
      renderedArtifactPath: staged.version.unitBackupPath,
      context,
    });
    const nextRecord: InstanceRecord = {
      ...loaded.record,
      generation: checkedNextGeneration(loaded.record.generation),
      currentVersion: request.nextVersion,
      previousVersion: loaded.record.currentVersion,
      versions: [...loaded.record.versions, staged.version],
      updatedAtMs: context.ports.clock.nowMs(),
    };
    journal.stored = await advanceJournal(context, loaded.paths, journal.stored, {
      phase: 'prepared', createdPaths: [...staged.created],
      target: { ...journal.stored.journal.target as NonNullable<typeof journal.stored.journal.target>, record: nextRecord },
    });
    return await cutover(context, loaded, staged.version, nextRecord, journal);
  } catch (error) {
    if (error instanceof UnrecoveredCutoverError || ['stopping', 'stopped', 'config_installing', 'config_installed', 'unit_installing', 'unit_installed', 'starting', 'healthy', 'record_installing', 'committed'].includes(journal.stored.journal.phase)) {
      throw error;
    }
    const failures: unknown[] = [error];
    if (staged) try { await cleanupCreatedPaths(context.ports.fileSystem, staged.created); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length === 1) try { await clearJournal(context, loaded.paths, journal.stored); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new InstanceManagerError('cleanup_failed', 'upgrade preparation cleanup is incomplete', { cause: new AggregateError(failures) });
    throw error;
  }
}

export async function rollbackInstance(
  context: InstanceManagerContext,
  request: VersionFence,
): Promise<InstanceStatus> {
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
  const nextRecord: InstanceRecord = {
    ...loaded.record,
    generation: checkedNextGeneration(loaded.record.generation),
    currentVersion: target.version,
    previousVersion: loaded.record.currentVersion,
    updatedAtMs: context.ports.clock.nowMs(),
  };
  const journal: JournalRef = { stored: await writeJournal(context, loaded.paths, newJournal({
    operationId: context.ports.ids.nextId(), operation: 'rollback', topology: request.topology,
    instanceId: request.instanceId, expectedGeneration: loaded.record.generation,
    expectedVersion: loaded.record.currentVersion, phase: 'prepared',
    target: { version: target.version, image: target.image, unitSha256: target.unitSha256, configSha256: target.configSha256, record: nextRecord },
    previousRecord: loaded.record, createdPaths: [], createdVolumes: [], removal: null,
  }), null) };
  try {
    return await cutover(context, loaded, target, nextRecord, journal);
  } catch (error) {
    if (journal.stored.journal.phase === 'prepared') await clearJournal(context, loaded.paths, journal.stored);
    throw error;
  }
}
