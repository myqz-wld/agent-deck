import { timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';

import { atomicWrite, ensureDirectoryChain, requireCanonicalFile, requireOwnedDirectory, validateExactTreeSnapshot } from './artifacts';
import type { CreatedPath } from './artifacts';
import type { InstanceManagerContext } from './context';
import { fullVolumeNames, generationPaths, type InstancePaths } from './paths';
import { canonicalJson, decodeUtf8, encodeJson, sha256, validateInstanceRecord } from './serialization';
import type {
  ExactTreeSnapshot,
  FileIdentity,
  InstanceManagerRoots,
  InstanceRecord,
  ManagedTopology,
  PodmanVolumeInspection,
} from './types';
import {
  assertPlainJson,
  fail,
  requireOwnedFile,
  requirePositiveSafeInteger,
  validateInstanceId,
  validateImage,
  isInside,
  validateAbsoluteRoot,
  validateOperationId,
  validateTopology,
  validateVersion,
  sameFileSnapshot,
} from './validation';

export type JournalOperation = 'create' | 'upgrade' | 'rollback' | 'remove';
export type JournalPhase =
  | 'intent' | 'prepared' | 'config_installing' | 'config_installed'
  | 'unit_installing' | 'unit_installed' | 'record_installing' | 'record_committed'
  | 'stopping' | 'stopped' | 'starting' | 'healthy' | 'committed'
  | 'unit_unlinking' | 'unit_unlinked' | 'reloading' | 'deleting_data' | 'complete';

export interface JournalTarget {
  readonly version: string;
  readonly image: string;
  readonly unitSha256: string;
  readonly configSha256: string;
  readonly record: InstanceRecord | null;
}

export interface RemovalIntent {
  readonly deleteData: boolean;
  readonly keepBackups: boolean;
  readonly trees: readonly ExactTreeSnapshot[];
  readonly volumes: readonly PodmanVolumeInspection[];
}

export interface OperationJournal {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly operation: JournalOperation;
  readonly topology: ManagedTopology;
  readonly instanceId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: string | null;
  readonly phase: JournalPhase;
  readonly target: JournalTarget | null;
  readonly previousRecord: InstanceRecord | null;
  readonly createdPaths: readonly CreatedPath[];
  readonly createdVolumes: readonly PodmanVolumeInspection[];
  readonly removal: RemovalIntent | null;
}

export interface StoredJournal {
  readonly journal: OperationJournal;
  readonly identity: FileIdentity;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (observed.length !== wanted.length || observed.some((key, index) => key !== wanted[index])) fail('tampered', `${field} has missing or extra fields`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('tampered', `${field} must be an object`);
  return value as Record<string, unknown>;
}

function validateIdentity(value: unknown, field: string): void {
  const identity = object(value, field);
  exactKeys(identity, ['device', 'inode', 'kind', 'mode', 'uid', 'size', 'modifiedAtMs'], field);
  if (
    !Number.isSafeInteger(identity.device) || (identity.device as number) < 0 ||
    !Number.isSafeInteger(identity.inode) || (identity.inode as number) <= 0 ||
    !['directory', 'file', 'symlink', 'other'].includes(identity.kind as string) ||
    !Number.isSafeInteger(identity.mode) || (identity.mode as number) < 0 ||
    !Number.isSafeInteger(identity.uid) || (identity.uid as number) < 0 ||
    !Number.isSafeInteger(identity.size) || (identity.size as number) < 0 ||
    typeof identity.modifiedAtMs !== 'number' ||
    !Number.isFinite(identity.modifiedAtMs) ||
    identity.modifiedAtMs < 0 ||
    identity.modifiedAtMs > Number.MAX_SAFE_INTEGER
  ) fail('tampered', `${field} contains an invalid filesystem identity`);
}

function validateCreatedPath(value: unknown, field: string): void {
  const entry = object(value, field);
  exactKeys(entry, ['path', 'identity', 'kind'], field);
  if (typeof entry.path !== 'string' || (entry.kind !== 'file' && entry.kind !== 'directory')) fail('tampered', `${field} is invalid`);
  validateAbsoluteRoot(entry.path, `${field}.path`);
  validateIdentity(entry.identity, `${field}.identity`);
  if ((entry.identity as FileIdentity).kind !== entry.kind) fail('tampered', `${field} kind does not match its identity`);
}

function validateVolume(value: unknown, field: string): void {
  const volume = object(value, field);
  exactKeys(volume, ['name', 'identity', 'labels'], field);
  if (typeof volume.name !== 'string' || typeof volume.identity !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(volume.name) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(volume.identity)) fail('tampered', `${field} is invalid`);
  const labels = object(volume.labels, `${field}.labels`);
  if (Object.keys(labels).length > 16 || Object.entries(labels).some(([key, nested]) => !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(key) || typeof nested !== 'string' || Buffer.byteLength(nested, 'utf8') > 256)) fail('tampered', `${field} labels are invalid`);
}

function validateTree(value: unknown, field: string): void {
  const tree = object(value, field);
  exactKeys(tree, ['rootPath', 'rootIdentity', 'entries'], field);
  if (typeof tree.rootPath !== 'string' || !Array.isArray(tree.entries)) fail('tampered', `${field} is invalid`);
  validateAbsoluteRoot(tree.rootPath, `${field}.rootPath`);
  validateIdentity(tree.rootIdentity, `${field}.rootIdentity`);
  for (const [index, nested] of tree.entries.entries()) {
    const entry = object(nested, `${field}.entries[${index}]`);
    exactKeys(entry, ['relativePath', 'identity'], `${field}.entries[${index}]`);
    if (typeof entry.relativePath !== 'string') fail('tampered', `${field} has an invalid relative path`);
    validateIdentity(entry.identity, `${field}.entries[${index}].identity`);
  }
  validateExactTreeSnapshot(tree as unknown as ExactTreeSnapshot);
}

const PHASES: Readonly<Record<JournalOperation, ReadonlySet<JournalPhase>>> = {
  create: new Set(['intent', 'prepared', 'config_installing', 'config_installed', 'unit_installing', 'unit_installed', 'record_installing', 'record_committed']),
  upgrade: new Set(['intent', 'prepared', 'stopping', 'stopped', 'config_installing', 'config_installed', 'unit_installing', 'unit_installed', 'starting', 'healthy', 'record_installing', 'committed']),
  rollback: new Set(['prepared', 'stopping', 'stopped', 'config_installing', 'config_installed', 'unit_installing', 'unit_installed', 'starting', 'healthy', 'record_installing', 'committed']),
  remove: new Set(['prepared', 'unit_unlinking', 'unit_unlinked', 'reloading', 'deleting_data', 'complete']),
};

function sameVersionTarget(target: JournalTarget, record: InstanceRecord): boolean {
  const version = record.versions.find((entry) => entry.version === target.version);
  return Boolean(
    version && version.image === target.image && version.unitSha256 === target.unitSha256 &&
    version.configSha256 === target.configSha256,
  );
}

function validateRecordBinding(journal: OperationJournal): void {
  const target = journal.target;
  const previous = journal.previousRecord;
  if (journal.operation === 'create') {
    if (journal.expectedGeneration !== 0 || journal.expectedVersion !== null || !target || previous || journal.removal) {
      fail('tampered', 'create journal fence or target relationship is invalid');
    }
    if (journal.phase !== 'intent' && !target.record) fail('tampered', 'prepared create journal is missing its target record');
    if (journal.phase === 'intent' && target.record !== null) fail('tampered', 'create intent must not claim a staged target record');
    if (journal.phase === 'intent' && (journal.createdPaths.length !== 0 || journal.createdVolumes.length !== 0)) fail('tampered', 'create intent cannot claim resources before preparation');
    if (target.record && (
      target.record.topology !== journal.topology || target.record.instanceId !== journal.instanceId ||
      target.record.generation !== 1 || target.record.currentVersion !== target.version ||
      target.record.previousVersion !== null || target.record.versions.length !== 1 ||
      !sameVersionTarget(target, target.record)
    )) fail('tampered', 'create target record is not bound to its exact journal target');
    return;
  }
  if (!previous || journal.expectedGeneration < 1 || journal.expectedVersion === null ||
      previous.topology !== journal.topology || previous.instanceId !== journal.instanceId ||
      previous.generation !== journal.expectedGeneration || previous.currentVersion !== journal.expectedVersion) {
    fail('tampered', 'journal previous record does not match its exact version fence');
  }
  if (journal.operation === 'remove') {
    if (target || !journal.removal) fail('tampered', 'remove journal target relationship is invalid');
    if (journal.createdPaths.length !== 1 || journal.createdPaths[0].kind !== 'file') fail('tampered', 'remove journal must bind one exact unit file');
    return;
  }
  if (!target || journal.removal) fail('tampered', 'change journal target relationship is invalid');
  if (journal.expectedGeneration === Number.MAX_SAFE_INTEGER) fail('tampered', 'journal generation cannot be incremented safely');
  if (journal.operation === 'upgrade' && journal.phase === 'intent') {
    if (target.record !== null) fail('tampered', 'upgrade intent must not claim a staged target record');
    if (journal.createdPaths.length !== 0) fail('tampered', 'upgrade intent cannot claim staged paths');
    if (target.version === journal.expectedVersion || previous.versions.some((entry) => entry.version === target.version)) fail('tampered', 'upgrade intent target is not a new recoverable version');
    return;
  }
  if (!target.record) fail('tampered', 'prepared change journal is missing its target record');
  if (
    target.record.topology !== journal.topology || target.record.instanceId !== journal.instanceId ||
    target.record.generation !== journal.expectedGeneration + 1 ||
    target.record.currentVersion !== target.version || target.record.previousVersion !== journal.expectedVersion ||
    !sameVersionTarget(target, target.record)
  ) fail('tampered', 'change target record is not bound to its exact journal fence');
  if (target.record.createdAtMs !== previous.createdAtMs || target.record.updatedAtMs < previous.updatedAtMs) fail('tampered', 'change record timestamps do not preserve instance identity');
  if (journal.operation === 'upgrade') {
    if (previous.versions.some((entry) => entry.version === target.version) || target.record.versions.length !== previous.versions.length + 1) fail('tampered', 'upgrade record does not append exactly one version');
    for (const version of previous.versions) {
      const retained = target.record.versions.find((entry) => entry.version === version.version);
      if (!retained || canonicalJson(retained) !== canonicalJson(version)) fail('tampered', 'upgrade record changed a prior recoverable version');
    }
  } else {
    if (previous.previousVersion !== target.version || canonicalJson(target.record.versions) !== canonicalJson(previous.versions) || journal.createdPaths.length !== 0) {
      fail('tampered', 'rollback record does not select the exact previous recoverable version');
    }
  }
}

function validateJournal(value: unknown): OperationJournal {
  assertPlainJson(value, 'operation journal');
  const journal = object(value, 'operation journal');
  exactKeys(journal, ['schemaVersion', 'operationId', 'operation', 'topology', 'instanceId', 'expectedGeneration', 'expectedVersion', 'phase', 'target', 'previousRecord', 'createdPaths', 'createdVolumes', 'removal'], 'operation journal');
  if (
    journal.schemaVersion !== 1 || typeof journal.operationId !== 'string' ||
    !['create', 'upgrade', 'rollback', 'remove'].includes(journal.operation as string) ||
    typeof journal.topology !== 'string' || typeof journal.instanceId !== 'string' ||
    typeof journal.expectedGeneration !== 'number' ||
    (journal.expectedVersion !== null && typeof journal.expectedVersion !== 'string') ||
    typeof journal.phase !== 'string' ||
    !Array.isArray(journal.createdPaths) || !Array.isArray(journal.createdVolumes)
  ) fail('tampered', 'operation journal contains invalid fields');
  validateOperationId(journal.operationId);
  validateTopology(journal.topology);
  validateInstanceId(journal.instanceId);
  if (!Number.isSafeInteger(journal.expectedGeneration) || journal.expectedGeneration < 0) fail('tampered', 'journal generation is invalid');
  if (journal.expectedVersion !== null) validateVersion(journal.expectedVersion, 'journal.expectedVersion');
  if (!PHASES[journal.operation as JournalOperation].has(journal.phase as JournalPhase)) fail('tampered', 'journal phase is invalid for its operation');
  if (journal.target !== null) {
    const target = object(journal.target, 'journal target');
    exactKeys(target, ['version', 'image', 'unitSha256', 'configSha256', 'record'], 'journal target');
    if (typeof target.version !== 'string' || typeof target.image !== 'string' || !/^[a-f0-9]{64}$/.test(target.unitSha256 as string) || !/^[a-f0-9]{64}$/.test(target.configSha256 as string)) fail('tampered', 'journal target is invalid');
    validateVersion(target.version);
    validateImage(target.image);
    if (target.record !== null) validateInstanceRecord(target.record);
  }
  if (journal.previousRecord !== null) validateInstanceRecord(journal.previousRecord);
  if (journal.createdPaths.length > 256 || journal.createdVolumes.length > 16) fail('tampered', 'journal resource list exceeds its bound');
  const createdPathNames = new Set<string>();
  for (const [index, entry] of journal.createdPaths.entries()) {
    validateCreatedPath(entry, `journal.createdPaths[${index}]`);
    if (createdPathNames.has(entry.path)) fail('tampered', 'journal contains a duplicate created path');
    createdPathNames.add(entry.path);
  }
  const createdVolumeNames = new Set<string>();
  for (const [index, volume] of journal.createdVolumes.entries()) {
    validateVolume(volume, `journal.createdVolumes[${index}]`);
    if (createdVolumeNames.has(volume.name)) fail('tampered', 'journal contains a duplicate created volume');
    createdVolumeNames.add(volume.name);
  }
  if (journal.removal !== null) {
    const removal = object(journal.removal, 'journal.removal');
    exactKeys(removal, ['deleteData', 'keepBackups', 'trees', 'volumes'], 'journal.removal');
    if (typeof removal.deleteData !== 'boolean' || typeof removal.keepBackups !== 'boolean' || !Array.isArray(removal.trees) || !Array.isArray(removal.volumes)) fail('tampered', 'journal removal intent is invalid');
    if (removal.trees.length > 16 || removal.volumes.length > 16) fail('tampered', 'journal removal resource list exceeds its bound');
    const roots = new Set<string>();
    for (const [index, tree] of removal.trees.entries()) {
      validateTree(tree, `journal.removal.trees[${index}]`);
      if (roots.has(tree.rootPath)) fail('tampered', 'journal removal contains a duplicate tree');
      roots.add(tree.rootPath);
    }
    const volumes = new Set<string>();
    for (const [index, volume] of removal.volumes.entries()) {
      validateVolume(volume, `journal.removal.volumes[${index}]`);
      if (volumes.has(volume.name)) fail('tampered', 'journal removal contains a duplicate volume');
      volumes.add(volume.name);
    }
  }
  const validated = journal as unknown as OperationJournal;
  if ((validated.operation === 'remove') !== Boolean(validated.removal)) fail('tampered', 'journal removal intent is operation-inconsistent');
  if ((validated.operation !== 'create' || validated.topology !== 'full') && validated.createdVolumes.length !== 0) fail('tampered', 'only Full create may record created volumes');
  validateRecordBinding(validated);
  return validated;
}

function encodeEnvelope(journal: OperationJournal, maxBytes: number): Uint8Array {
  validateJournal(journal);
  return encodeJson({ schemaVersion: 1, journal, sha256: sha256(canonicalJson(journal)) }, maxBytes);
}

function validateRecordPaths(record: InstanceRecord | null, paths: InstancePaths): void {
  if (!record) return;
  for (const version of record.versions) {
    const expected = generationPaths(paths, version.version);
    if (version.unitBackupPath !== expected.unitPath || version.configBackupPath !== expected.configPath) {
      fail('tampered', 'journal record contains an artifact outside its exact generation namespace');
    }
  }
}

function validateNamespaceBinding(journal: OperationJournal, paths: InstancePaths, roots: InstanceManagerRoots, serviceUid: number): void {
  const createdChains: readonly [string, string][] = [
    [roots.serviceHome, paths.configDirectory], [roots.runtimeRoot, paths.runtimeDirectory],
    [roots.metadataRoot, paths.metadataDirectory], [roots.backupRoot, paths.backupDirectory],
    ...(paths.stateDirectory ? [[roots.serviceHome, paths.stateDirectory] as [string, string]] : []),
  ];
  for (const entry of journal.createdPaths) {
    const inExactChain = createdChains.some(([root, target]) => entry.path !== root && isInside(entry.path, root) && (isInside(entry.path, target) || isInside(target, entry.path)));
    if (entry.path !== paths.unitPath && !inExactChain) fail('tampered', 'journal created path is outside its exact instance namespace');
    const expectedMode = entry.kind === 'directory' ? 0o700
      : entry.path === paths.unitPath || entry.path.endsWith('.container') ? 0o444
        : isInside(entry.path, paths.backupDirectory) ? 0o400 : 0o600;
    if (entry.identity.uid !== serviceUid || (entry.identity.mode & 0o777) !== expectedMode) fail('tampered', 'journal created path has an unexpected owner or mode');
  }
  validateRecordPaths(journal.previousRecord, paths);
  validateRecordPaths(journal.target?.record ?? null, paths);
  if (journal.operation === 'create' && journal.createdVolumes.length !== 0) {
    const expected = fullVolumeNames(journal.instanceId);
    if (journal.createdVolumes.length !== expected.length || journal.createdVolumes.some((volume, index) => volume.name !== expected[index])) fail('tampered', 'create journal volume set is not exact');
  }
  if (journal.operation !== 'remove') return;
  if (journal.createdPaths[0].path !== paths.unitPath) fail('tampered', 'remove journal does not bind the exact unit path');
  const removal = journal.removal as RemovalIntent;
  const required = new Set([paths.metadataDirectory, ...(!removal.keepBackups ? [paths.backupDirectory] : []), ...(removal.deleteData ? [paths.configDirectory, paths.runtimeDirectory, ...(paths.stateDirectory ? [paths.stateDirectory] : [])] : [])]);
  const allowed = new Set([...required, paths.cutoverEvidenceDirectory, ...(journal.topology === 'relay' ? [paths.evidenceDirectory] : [])]);
  const observed = new Set(removal.trees.map((tree) => tree.rootPath));
  if (removal.trees.some((tree) => !allowed.has(tree.rootPath)) || [...required].some((path) => !observed.has(path))) fail('tampered', 'remove journal tree choices do not match its exact namespace');
  const expectedVolumes = journal.topology === 'full' && removal.deleteData ? fullVolumeNames(journal.instanceId) : [];
  if (removal.volumes.length !== expectedVolumes.length || removal.volumes.some((volume, index) => volume.name !== expectedVolumes[index])) fail('tampered', 'remove journal volume choices do not match its exact namespace');
}

function decodeEnvelope(bytes: Uint8Array, maxBytes: number): OperationJournal {
  let parsed: unknown;
  try { parsed = JSON.parse(decodeUtf8(bytes, 'operation journal')); } catch { fail('tampered', 'operation journal is not valid JSON'); }
  const envelope = object(parsed, 'operation journal envelope');
  exactKeys(envelope, ['schemaVersion', 'journal', 'sha256'], 'operation journal envelope');
  if (envelope.schemaVersion !== 1 || typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sha256)) fail('tampered', 'operation journal envelope is invalid');
  const journal = validateJournal(envelope.journal);
  const expected = Buffer.from(sha256(canonicalJson(journal)), 'hex');
  const observed = Buffer.from(envelope.sha256, 'hex');
  if (!timingSafeEqual(expected, observed)) fail('tampered', 'operation journal checksum mismatch');
  const canonical = encodeEnvelope(journal, maxBytes);
  if (canonical.byteLength !== bytes.byteLength || !timingSafeEqual(Buffer.from(canonical), Buffer.from(bytes))) fail('tampered', 'operation journal is not canonical');
  return journal;
}

export async function readJournal(context: InstanceManagerContext, paths: InstancePaths): Promise<StoredJournal | null> {
  const journalDirectory = posix.dirname(paths.journalPath);
  const parent = await context.ports.fileSystem.lstat(journalDirectory);
  if (parent) {
    await requireOwnedDirectory(context.ports.fileSystem, journalDirectory, context.serviceUid, 0o700, 'operation journal directory');
    const prefix = `.${posix.basename(paths.journalPath)}.`;
    const entries = await context.ports.fileSystem.listDirectory(journalDirectory, 2_048);
    if (entries.some((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.tmp'))) {
      fail('recovery_required', 'an interrupted journal atomic write requires manual recovery');
    }
  }
  const identity = await context.ports.fileSystem.lstat(paths.journalPath);
  if (!identity) return null;
  const stored = await requireCanonicalFile(context.ports.fileSystem, paths.journalPath, context.limits.maxArtifactBytes, 'operation journal');
  requireOwnedFile(stored.identity, context.serviceUid, 0o600, 'operation journal');
  const journal = decodeEnvelope(stored.bytes, context.limits.maxArtifactBytes);
  if (journal.topology !== paths.topology || journal.instanceId !== paths.instanceId) fail('tampered', 'operation journal is in the wrong exact namespace');
  validateNamespaceBinding(journal, paths, context.roots, context.serviceUid);
  return { journal, identity: stored.identity };
}

export async function writeJournal(
  context: InstanceManagerContext,
  paths: InstancePaths,
  journal: OperationJournal,
  expected: FileIdentity | null,
): Promise<StoredJournal> {
  const encoded = encodeEnvelope(journal, context.limits.maxArtifactBytes);
  validateNamespaceBinding(journal, paths, context.roots, context.serviceUid);
  const created: CreatedPath[] = [];
  await ensureDirectoryChain(context.ports.fileSystem, context.roots.journalRoot, posix.dirname(paths.journalPath), created, context.serviceUid);
  const identity = await atomicWrite(context.ports.fileSystem, paths.journalPath, encoded, 0o600, expected, context.ports.ids.nextId());
  requireOwnedFile(identity, context.serviceUid, 0o600, 'operation journal');
  return { journal, identity };
}

export async function advanceJournal(
  context: InstanceManagerContext,
  paths: InstancePaths,
  stored: StoredJournal,
  patch: Partial<OperationJournal>,
): Promise<StoredJournal> {
  return writeJournal(context, paths, { ...stored.journal, ...patch }, stored.identity);
}

export async function clearJournal(context: InstanceManagerContext, paths: InstancePaths, stored: StoredJournal): Promise<void> {
  const observed = await context.ports.fileSystem.lstat(paths.journalPath);
  if (!observed || !sameFileSnapshot(observed, stored.identity)) fail('tampered', 'operation journal identity changed before clear');
  await context.ports.fileSystem.removeFileExact(paths.journalPath, stored.identity);
}

export function newJournal(input: Omit<OperationJournal, 'schemaVersion'>): OperationJournal {
  requirePositiveSafeInteger(input.operationId.length, 'operationId length');
  return { schemaVersion: 1, ...input };
}
