import { cleanupCreatedPaths, requireCanonicalFile, validateExactTreeSnapshot } from './artifacts';
import type { InstanceManagerContext } from './context';
import { exactLabels, volumeLabels } from './create';
import { advanceJournal, clearJournal, readJournal, type StoredJournal } from './journal';
import { evidencePaths, revalidateEvidence, validateStartEvidence } from './evidence';
import { loadInstance } from './instance-reader';
import { assertExactLoadedUnitStatus } from './lifecycle';
import { fullVolumeNames, resolveInstancePaths } from './paths';
import { runStartPreflight } from './preflight';
import { canonicalJson, decodeRecord, encodeRecord, sha256 } from './serialization';
import type { ExactTreeSnapshot, InstanceSelector, PodmanVolumeInspection } from './types';
import { atomicWrite } from './artifacts';
import { fail, InstanceManagerError, isInside, requireOwnedFile, sameFileSnapshot, sameIdentity } from './validation';
import { waitForHealthyContainer } from './container-health';
import { verifyFullRuntimeConfig } from './full-runtime-config';

function validateCreatedPaths(paths: ReturnType<typeof resolveInstancePaths>, entries: StoredJournal['journal']['createdPaths']): void {
  const roots = [paths.configDirectory, paths.runtimeDirectory, paths.metadataDirectory, paths.backupDirectory, ...(paths.stateDirectory ? [paths.stateDirectory] : [])];
  for (const entry of entries) {
    if (entry.path !== paths.unitPath && !roots.some((root) => isInside(entry.path, root))) fail('tampered', 'journal created path is outside its exact instance namespace');
  }
}

async function exactFileDigest(
  context: InstanceManagerContext,
  path: string,
  digest: string,
  mode: number,
): Promise<ReturnType<typeof requireCanonicalFile> | null> {
  if (!(await context.ports.fileSystem.lstat(path))) return null;
  const file = await requireCanonicalFile(context.ports.fileSystem, path, context.limits.maxArtifactBytes, 'recovery artifact');
  requireOwnedFile(file.identity, context.serviceUid, mode, 'recovery artifact');
  if (sha256(file.bytes) !== digest) fail('recovery_required', 'recovery artifact does not match the journal target');
  return file;
}

async function removeCreatedVolumes(
  context: InstanceManagerContext,
  volumes: readonly PodmanVolumeInspection[],
): Promise<void> {
  for (const expected of volumes) {
    const observed = await context.ports.podman.inspectVolume(expected.name, context.limits.commandTimeoutMs);
    if (!observed) continue;
    if (observed.identity !== expected.identity || !exactLabels(observed.labels, expected.labels)) fail('recovery_required', 'journal volume identity no longer matches');
    await context.ports.podman.removeVolumeExact(observed, context.limits.commandTimeoutMs);
  }
}

async function recoverCreate(context: InstanceManagerContext, stored: StoredJournal): Promise<void> {
  const paths = resolveInstancePaths(context.roots, stored.journal.topology, stored.journal.instanceId);
  const target = stored.journal.target;
  if (!target) fail('recovery_required', 'create journal is missing its target artifacts');
  validateCreatedPaths(paths, stored.journal.createdPaths);
  if (stored.journal.createdVolumes.some((volume, index) => volume.name !== fullVolumeNames(stored.journal.instanceId)[index])) fail('tampered', 'create journal contains an unrelated volume');
  const recordIdentity = await context.ports.fileSystem.lstat(paths.recordPath);
  if (recordIdentity) {
    if (!target.record) fail('recovery_required', 'create record exists before its journal target was finalized');
    const loaded = await loadInstance({ selector: stored.journal, roots: context.roots, ports: context.ports, maxArtifactBytes: context.limits.maxArtifactBytes, serviceUid: context.serviceUid });
    if (canonicalJson(loaded.record) !== canonicalJson(target.record)) fail('recovery_required', 'created record differs from its durable journal');
    if (loaded.record.topology === 'full') {
      await verifyFullRuntimeConfig(
        context,
        loaded.record.instanceId,
        loaded.current.configSha256,
      );
    }
    try {
      await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs);
      const status = await context.ports.systemd.statusUserUnit(paths.unitName, context.limits.lifecycleTimeoutMs);
      assertExactLoadedUnitStatus(paths, status);
    } catch (error) {
      throw new InstanceManagerError('recovery_required', 'committed create could not verify its daemon reload', { cause: error });
    }
    await clearJournal(context, paths, stored);
    return;
  }
  const unit = await exactFileDigest(context, paths.unitPath, target.unitSha256, 0o444);
  const config = await exactFileDigest(context, paths.configFile, target.configSha256, 0o600);
  if (unit) await context.ports.fileSystem.removeFileExact(paths.unitPath, unit.identity);
  if (config) await context.ports.fileSystem.removeFileExact(paths.configFile, config.identity);
  await removeCreatedVolumes(context, stored.journal.createdVolumes);
  await cleanupCreatedPaths(context.ports.fileSystem, stored.journal.createdPaths);
  for (const path of new Set([paths.configDirectory, paths.stateDirectory, paths.runtimeDirectory, paths.unitPath, paths.metadataDirectory, paths.backupDirectory, paths.evidenceDirectory, paths.cutoverEvidenceDirectory].filter((value): value is string => value !== null))) {
    if (await context.ports.fileSystem.lstat(path)) fail('recovery_required', 'create recovery found an uncertain residual namespace');
  }
  if (stored.journal.topology === 'full') {
    for (const name of fullVolumeNames(stored.journal.instanceId)) {
      if (await context.ports.podman.inspectVolume(name, context.limits.commandTimeoutMs)) fail('recovery_required', 'create recovery found an unjournaled volume');
    }
  }
  await clearJournal(context, paths, stored);
}

async function recoverCommittedChange(context: InstanceManagerContext, stored: StoredJournal): Promise<boolean> {
  const paths = resolveInstancePaths(context.roots, stored.journal.topology, stored.journal.instanceId);
  const targetRecord = stored.journal.target?.record;
  if (!targetRecord || !(await context.ports.fileSystem.lstat(paths.recordPath))) return false;
  try {
    const loaded = await loadInstance({ selector: stored.journal, roots: context.roots, ports: context.ports, maxArtifactBytes: context.limits.maxArtifactBytes, serviceUid: context.serviceUid });
    if (canonicalJson(loaded.record) !== canonicalJson(targetRecord)) return false;
    if (loaded.record.topology === 'full') {
      await verifyFullRuntimeConfig(
        context,
        loaded.record.instanceId,
        loaded.current.configSha256,
      );
    }
    await clearJournal(context, paths, stored);
    return true;
  } catch { return false; }
}

async function recoverHealthyChange(context: InstanceManagerContext, stored: StoredJournal): Promise<boolean> {
  if (!['starting', 'healthy', 'record_installing'].includes(stored.journal.phase)) return false;
  const target = stored.journal.target;
  const previous = stored.journal.previousRecord;
  if (!target?.record || !previous) return false;
  const paths = resolveInstancePaths(context.roots, stored.journal.topology, stored.journal.instanceId);
  const targetVersion = target.record.versions.find((version) => version.version === target.version);
  if (!targetVersion) fail('recovery_required', 'cutover journal target version is missing');
  const evidence = await validateStartEvidence({ topology: paths.topology, paths, generation: target.record.generation, version: targetVersion, fileSystem: context.ports.fileSystem, clock: context.ports.clock, serviceUid: context.serviceUid, trustedRootUid: context.trustedRootUid, maxAgeMs: context.limits.maxEvidenceAgeMs });
  const preflightEvidence = evidencePaths(paths.topology, paths);
  await runStartPreflight({ topology: paths.topology, paths, renderedArtifactPath: targetVersion.unitBackupPath, egressEvidencePath: preflightEvidence[0], quotaEvidencePath: preflightEvidence[1], context });
  await revalidateEvidence(context.ports.fileSystem, evidence, context.ports.clock, context.limits.maxEvidenceAgeMs);
  const unit = await exactFileDigest(context, paths.unitPath, target.unitSha256, 0o444);
  const config = await exactFileDigest(context, paths.configFile, target.configSha256, 0o600);
  if (!unit || !config) fail('recovery_required', 'cutover target artifacts are not both installed');
  if (paths.topology === 'full') {
    await verifyFullRuntimeConfig(
      context,
      paths.instanceId,
      target.configSha256,
    );
  }
  const record = await requireCanonicalFile(context.ports.fileSystem, paths.recordPath, context.limits.maxArtifactBytes, 'recovery record');
  requireOwnedFile(record.identity, context.serviceUid, 0o600, 'recovery record');
  if (canonicalJson(decodeRecord(record.bytes)) !== canonicalJson(previous)) return false;
  const status = await context.ports.systemd.statusUserUnit(paths.unitName, context.limits.lifecycleTimeoutMs);
  try { assertExactLoadedUnitStatus(paths, status); } catch { return false; }
  if (status.activeState !== 'active') return false;
  try {
    await waitForHealthyContainer(context, {
      name: paths.containerName,
      image: target.image,
    });
  } catch {
    return false;
  }
  const committed = await atomicWrite(context.ports.fileSystem, paths.recordPath, encodeRecord(target.record), 0o600, record.identity, context.ports.ids.nextId());
  requireOwnedFile(committed, context.serviceUid, 0o600, 'recovered record');
  const refreshed = await readJournal(context, paths);
  if (!refreshed || refreshed.journal.operationId !== stored.journal.operationId) fail('recovery_required', 'journal changed during record recovery');
  await clearJournal(context, paths, refreshed);
  return true;
}

async function recoverChange(context: InstanceManagerContext, stored: StoredJournal): Promise<void> {
  if (await recoverCommittedChange(context, stored)) return;
  const paths = resolveInstancePaths(context.roots, stored.journal.topology, stored.journal.instanceId);
  if (stored.journal.phase === 'prepared' && stored.journal.previousRecord) {
    validateCreatedPaths(paths, stored.journal.createdPaths);
    const loaded = await loadInstance({ selector: stored.journal, roots: context.roots, ports: context.ports, maxArtifactBytes: context.limits.maxArtifactBytes, serviceUid: context.serviceUid });
    if (loaded.record.topology === 'full') {
      await verifyFullRuntimeConfig(
        context,
        loaded.record.instanceId,
        loaded.current.configSha256,
      );
    }
    if (canonicalJson(loaded.record) === canonicalJson(stored.journal.previousRecord)) {
      await cleanupCreatedPaths(context.ports.fileSystem, stored.journal.createdPaths);
      await clearJournal(context, paths, stored);
      return;
    }
  }
  if (await recoverHealthyChange(context, stored)) return;
  fail('recovery_required', 'interrupted cutover requires manual recovery with its journal preserved');
}

async function exactTreePresent(context: InstanceManagerContext, expected: ExactTreeSnapshot): Promise<boolean> {
  const root = await context.ports.fileSystem.lstat(expected.rootPath);
  if (!root) return false;
  if (!sameFileSnapshot(root, expected.rootIdentity)) fail('recovery_required', 'removal tree root identity changed');
  const captured = await context.ports.fileSystem.captureTreeExact(expected.rootPath, Math.max(1, expected.entries.length + 1));
  validateExactTreeSnapshot(captured, expected.entries.length + 1);
  if (canonicalJson(captured) !== canonicalJson(expected)) fail('recovery_required', 'removal tree descendants changed');
  return true;
}

async function exactVolumePresent(context: InstanceManagerContext, expected: PodmanVolumeInspection): Promise<boolean> {
  const observed = await context.ports.podman.inspectVolume(expected.name, context.limits.commandTimeoutMs);
  if (!observed) return false;
  if (observed.identity !== expected.identity || !exactLabels(observed.labels, expected.labels)) fail('recovery_required', 'removal volume identity changed');
  return true;
}

async function requireRemovalResourcesPresent(context: InstanceManagerContext, intent: NonNullable<StoredJournal['journal']['removal']>): Promise<void> {
  for (const tree of intent.trees) if (!(await exactTreePresent(context, tree))) fail('recovery_required', 'removal tree disappeared before durable deletion');
  for (const volume of intent.volumes) if (!(await exactVolumePresent(context, volume))) fail('recovery_required', 'removal volume disappeared before durable deletion');
}

async function requireRemovalResourcesAbsent(context: InstanceManagerContext, intent: NonNullable<StoredJournal['journal']['removal']>): Promise<void> {
  for (const tree of intent.trees) if (await context.ports.fileSystem.lstat(tree.rootPath)) fail('recovery_required', 'completed removal tree reappeared');
  for (const volume of intent.volumes) if (await context.ports.podman.inspectVolume(volume.name, context.limits.commandTimeoutMs)) fail('recovery_required', 'completed removal volume reappeared');
}

async function requireRemovedUnit(context: InstanceManagerContext, paths: ReturnType<typeof resolveInstancePaths>): Promise<void> {
  if (await context.ports.fileSystem.lstat(paths.unitPath)) fail('recovery_required', 'removed unit reappeared');
  const status = await context.ports.systemd.statusUserUnit(paths.unitName, context.limits.lifecycleTimeoutMs);
  if (status.unitName !== paths.unitName || status.fragmentPath !== '' || status.loadState !== 'not-found' || status.activeState !== 'inactive' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(status.subState)) {
    fail('recovery_required', 'removed unit is not provably absent and inactive');
  }
}

async function recoverRemove(context: InstanceManagerContext, initial: StoredJournal): Promise<void> {
  let stored = initial;
  const paths = resolveInstancePaths(context.roots, stored.journal.topology, stored.journal.instanceId);
  const intent = stored.journal.removal;
  const unitEntry = stored.journal.createdPaths.find((entry) => entry.path === paths.unitPath);
  if (!intent || !unitEntry) fail('recovery_required', 'remove journal is missing exact resource identities');
  const requiredTrees = new Set([
    paths.metadataDirectory,
    ...(!intent.keepBackups ? [paths.backupDirectory] : []),
    ...(intent.deleteData ? [paths.configDirectory, paths.runtimeDirectory, ...(paths.stateDirectory ? [paths.stateDirectory] : [])] : []),
  ]);
  const allowedTrees = new Set([...requiredTrees, paths.cutoverEvidenceDirectory, ...(stored.journal.topology === 'relay' ? [paths.evidenceDirectory] : [])]);
  const observedTrees = new Set<string>();
  for (const tree of intent.trees) {
    if (!allowedTrees.has(tree.rootPath) || observedTrees.has(tree.rootPath)) fail('tampered', 'remove journal contains a tree outside its exact choices');
    if (
      (tree.rootPath === paths.cutoverEvidenceDirectory || (stored.journal.topology === 'relay' && tree.rootPath === paths.evidenceDirectory)) &&
      (tree.rootIdentity.uid !== context.trustedRootUid || (tree.rootIdentity.mode & 0o777) !== 0o555 || tree.entries.some((entry) => entry.identity.uid !== context.trustedRootUid || (entry.identity.mode & 0o777) !== (entry.identity.kind === 'directory' ? 0o555 : 0o444)))
    ) fail('tampered', 'remove journal contains an untrusted evidence snapshot');
    observedTrees.add(tree.rootPath);
  }
  if ([...requiredTrees].some((path) => !observedTrees.has(path))) fail('tampered', 'remove journal omits a required exact tree');
  const allowedVolumes = stored.journal.topology === 'full' && intent.deleteData ? fullVolumeNames(stored.journal.instanceId) : [];
  if (intent.volumes.length !== allowedVolumes.length || intent.volumes.some((volume, index) => volume.name !== allowedVolumes[index] || !exactLabels(volume.labels, volumeLabels(stored.journal.instanceId, volume.name.slice(volume.name.lastIndexOf('-') + 1))))) {
    fail('tampered', 'remove journal contains a volume outside its exact instance');
  }
  let unit = await context.ports.fileSystem.lstat(paths.unitPath);
  if (stored.journal.phase === 'prepared') {
    if (!unit || !sameIdentity(unit, unitEntry.identity)) fail('recovery_required', 'prepared remove no longer has its exact unit');
    await requireRemovalResourcesPresent(context, intent);
    await clearJournal(context, paths, stored);
    return;
  }
  if (stored.journal.phase === 'unit_unlinking') {
    if (unit) {
      if (!sameIdentity(unit, unitEntry.identity)) fail('recovery_required', 'remove unit identity changed during recovery');
      const status = await context.ports.systemd.statusUserUnit(paths.unitName, context.limits.lifecycleTimeoutMs);
      assertExactLoadedUnitStatus(paths, status);
      if (status.activeState !== 'inactive') fail('not_stopped', 'remove recovery found an active exact unit');
      await context.ports.fileSystem.removeFileExact(paths.unitPath, unitEntry.identity);
    }
    stored = await advanceJournal(context, paths, stored, { phase: 'unit_unlinked' });
    unit = null;
  } else if (unit) {
    fail('recovery_required', 'removed unit reappeared after durable unlink');
  }
  if (stored.journal.phase === 'unit_unlinked') {
    stored = await advanceJournal(context, paths, stored, { phase: 'reloading' });
  }
  if (stored.journal.phase === 'reloading') {
    await context.ports.systemd.daemonReload(context.limits.lifecycleTimeoutMs);
    await requireRemovedUnit(context, paths);
    await requireRemovalResourcesPresent(context, intent);
    stored = await advanceJournal(context, paths, stored, { phase: 'deleting_data' });
  }
  if (stored.journal.phase === 'deleting_data') {
    await requireRemovedUnit(context, paths);
    for (const volume of intent.volumes) {
      if (await exactVolumePresent(context, volume)) await context.ports.podman.removeVolumeExact(volume, context.limits.commandTimeoutMs);
    }
    for (const tree of intent.trees) {
      if (!(await exactTreePresent(context, tree))) continue;
      try { await context.ports.fileSystem.removeTreeExact(tree); } catch (error) {
        throw new InstanceManagerError('recovery_required', 'exact removal tree changed; journal preserved', { cause: error });
      }
    }
    stored = await advanceJournal(context, paths, stored, { phase: 'complete' });
  }
  if (stored.journal.phase !== 'complete') fail('recovery_required', 'remove recovery reached an invalid durable phase');
  await requireRemovedUnit(context, paths);
  await requireRemovalResourcesAbsent(context, intent);
  await clearJournal(context, paths, stored);
}

export async function recoverPendingOperation(context: InstanceManagerContext, selector: InstanceSelector): Promise<void> {
  const paths = resolveInstancePaths(context.roots, selector.topology, selector.instanceId);
  const stored = await readJournal(context, paths);
  if (!stored) return;
  try {
    if (stored.journal.operation === 'create') return await recoverCreate(context, stored);
    if (stored.journal.operation === 'remove') return await recoverRemove(context, stored);
    return await recoverChange(context, stored);
  } catch (error) {
    if (error instanceof InstanceManagerError) throw error;
    throw new InstanceManagerError('recovery_required', 'durable lifecycle recovery could not prove a safe transition', { cause: error });
  }
}

export async function assertNoPendingOperation(context: InstanceManagerContext, selector: InstanceSelector): Promise<void> {
  const stored = await readJournal(context, resolveInstancePaths(context.roots, selector.topology, selector.instanceId));
  if (stored) fail('recovery_required', 'instance has a pending durable lifecycle operation');
}
