import type { InstancePaths } from './paths';
import { generationPaths, resolveInstancePaths } from './paths';
import { requireCanonicalFile, requireOwnedDirectory } from './artifacts';
import { decodeRecord, sha256 } from './serialization';
import type {
  FileIdentity,
  InstanceManagerPorts,
  InstanceManagerRoots,
  InstanceRecord,
  InstanceSelector,
  ManagedVersion,
} from './types';
import { fail } from './validation';
import { requireOwnedFile } from './validation';
import { readVersionArtifacts } from './version-artifacts';

export interface LoadedInstance {
  readonly paths: InstancePaths;
  readonly record: InstanceRecord;
  readonly recordIdentity: FileIdentity;
  readonly current: ManagedVersion;
  readonly unitIdentity: FileIdentity;
  readonly configIdentity: FileIdentity;
}

function validateVersionPaths(paths: InstancePaths, version: ManagedVersion): void {
  const expected = generationPaths(paths, version.version);
  if (
    version.unitBackupPath !== expected.unitPath ||
    version.configBackupPath !== expected.configPath
  ) {
    fail('tampered', 'record version artifact path is not the exact instance backup path');
  }
}

export async function loadInstance(input: {
  readonly selector: InstanceSelector;
  readonly roots: InstanceManagerRoots;
  readonly ports: InstanceManagerPorts;
  readonly maxArtifactBytes: number;
  readonly serviceUid: number;
}): Promise<LoadedInstance> {
  const paths = resolveInstancePaths(
    input.roots,
    input.selector.topology,
    input.selector.instanceId,
  );
  if (!(await input.ports.fileSystem.lstat(paths.recordPath))) {
    fail('not_found', 'instance record does not exist');
  }
  const managedDirectories: [string, string][] = [
    [paths.configDirectory, 'instance config directory'],
    [paths.runtimeDirectory, 'instance runtime directory'],
    [paths.metadataDirectory, 'instance metadata directory'],
    [paths.backupDirectory, 'instance backup directory'],
  ];
  if (paths.stateDirectory) managedDirectories.push([paths.stateDirectory, 'instance state directory']);
  for (const [path, field] of managedDirectories) {
    await requireOwnedDirectory(input.ports.fileSystem, path, input.serviceUid, 0o700, field);
  }
  const stored = await requireCanonicalFile(
    input.ports.fileSystem,
    paths.recordPath,
    input.maxArtifactBytes,
    'instance record',
  );
  const record = decodeRecord(stored.bytes);
  requireOwnedFile(stored.identity, input.serviceUid, 0o600, 'instance record');
  if (record.topology !== input.selector.topology || record.instanceId !== input.selector.instanceId) {
    fail('tampered', 'record identity does not match its exact namespace');
  }
  for (const version of record.versions) validateVersionPaths(paths, version);
  const current = record.versions.find((version) => version.version === record.currentVersion);
  if (!current) fail('tampered', 'current record version is missing');
  await readVersionArtifacts({
    ports: input.ports,
    version: current,
    maxArtifactBytes: input.maxArtifactBytes,
    expectedUid: input.serviceUid,
  });
  const unit = await requireCanonicalFile(
    input.ports.fileSystem,
    paths.unitPath,
    input.maxArtifactBytes,
    'installed Quadlet',
  );
  const config = await requireCanonicalFile(
    input.ports.fileSystem,
    paths.configFile,
    input.maxArtifactBytes,
    'installed runtime config',
  );
  requireOwnedFile(unit.identity, input.serviceUid, 0o444, 'installed Quadlet');
  requireOwnedFile(config.identity, input.serviceUid, 0o600, 'installed runtime config');
  if (sha256(unit.bytes) !== current.unitSha256 || sha256(config.bytes) !== current.configSha256) {
    fail('tampered', 'installed artifacts do not match the current recoverable version');
  }
  return {
    paths,
    record,
    recordIdentity: stored.identity,
    current,
    unitIdentity: unit.identity,
    configIdentity: config.identity,
  };
}

export function assertVersionFence(
  loaded: LoadedInstance,
  expectedGeneration: number,
  expectedVersion: string,
): void {
  if (
    loaded.record.generation !== expectedGeneration ||
    loaded.record.currentVersion !== expectedVersion
  ) {
    fail('conflict', 'instance generation or expected version changed');
  }
}

export async function revalidateLoadedArtifacts(
  input: Pick<Parameters<typeof loadInstance>[0], 'ports' | 'maxArtifactBytes' | 'serviceUid'> & {
    readonly loaded: LoadedInstance;
    readonly version?: ManagedVersion;
  },
): Promise<void> {
  const version = input.version ?? input.loaded.current;
  const unit = await requireCanonicalFile(input.ports.fileSystem, input.loaded.paths.unitPath, input.maxArtifactBytes, 'installed Quadlet recheck');
  const config = await requireCanonicalFile(input.ports.fileSystem, input.loaded.paths.configFile, input.maxArtifactBytes, 'installed config recheck');
  requireOwnedFile(unit.identity, input.serviceUid, 0o444, 'installed Quadlet recheck');
  requireOwnedFile(config.identity, input.serviceUid, 0o600, 'installed config recheck');
  if (sha256(unit.bytes) !== version.unitSha256 || sha256(config.bytes) !== version.configSha256) {
    fail('tampered', 'installed artifacts changed before lifecycle transition');
  }
}
