import { posix } from 'node:path';

import type { InstancePaths } from './paths';
import { generationPaths } from './paths';
import {
  atomicWrite,
  captureTrustedFile,
  cleanupCreatedPaths,
  ensureDirectoryChain,
  requireCanonicalFile,
  requireOwnedDirectory,
  type CreatedPath,
} from './artifacts';
import { decodeUtf8, encodeJson, sha256 } from './serialization';
import type {
  FileIdentity,
  FullResourceSpec,
  InstanceManagerPorts,
  InstanceManagerRoots,
  ManagedTopology,
  ManagedVersion,
} from './types';
import { renderQuadlet } from './render';
import { validateFullVersionPolicy } from './full-policy';
import { fail, requireOwnedFile, sameFileSnapshot, validateVersion } from './validation';

export interface StagedVersion {
  readonly version: ManagedVersion;
  readonly unitBytes: Uint8Array;
  readonly configBytes: Uint8Array;
  readonly unitIdentity: FileIdentity;
  readonly configIdentity: FileIdentity;
  readonly created: readonly CreatedPath[];
}

type PrepareInput = Omit<Parameters<typeof stageVersion>[0], 'version'>;

export async function prepareVersionArtifacts(input: PrepareInput): Promise<{
  readonly unitBytes: Uint8Array;
  readonly configBytes: Uint8Array;
  readonly unitSha256: string;
  readonly configSha256: string;
}> {
  const templateTrust = await captureTrustedFile(input.ports.fileSystem, input.paths.templatePath, input.maxArtifactBytes, input.trustedArtifactUid, 0o444, 'Quadlet template');
  const template = await requireCanonicalFile(input.ports.fileSystem, templateTrust.path, input.maxArtifactBytes, 'Quadlet template');
  if (!sameFileSnapshot(template.identity, templateTrust.identity)) fail('tampered', 'Quadlet template changed before render');
  if (input.topology === 'full') {
    if (!input.fullResources) fail('invalid_input', 'fullResources are required for full instances');
    validateFullVersionPolicy({ instanceId: input.paths.instanceId, image: input.image, resources: input.fullResources });
  }
  const unitBytes = new TextEncoder().encode(renderQuadlet({ topology: input.topology, instanceId: input.paths.instanceId, image: input.image, template: template.bytes, fullResources: input.fullResources }));
  const configBytes = encodeJson(input.runtimeConfig, input.maxArtifactBytes);
  if (unitBytes.byteLength > input.maxArtifactBytes) fail('invalid_input', 'version artifacts exceed the configured bound');
  return { unitBytes, configBytes, unitSha256: sha256(unitBytes), configSha256: sha256(configBytes) };
}

export async function stageVersion(input: {
  readonly topology: ManagedTopology;
  readonly paths: InstancePaths;
  readonly roots: InstanceManagerRoots;
  readonly ports: InstanceManagerPorts;
  readonly version: string;
  readonly image: string;
  readonly runtimeConfig: unknown;
  readonly fullResources?: FullResourceSpec;
  readonly maxArtifactBytes: number;
  readonly expectedUid: number;
  readonly trustedArtifactUid: number;
}): Promise<StagedVersion> {
  validateVersion(input.version);
  const generation = generationPaths(input.paths, input.version);
  if (await input.ports.fileSystem.lstat(generation.directory)) {
    fail('already_exists', 'version backup already exists');
  }
  const created: CreatedPath[] = [];
  try {
    await ensureDirectoryChain(
      input.ports.fileSystem,
      input.roots.backupRoot,
      generation.directory,
      created,
      input.expectedUid,
    );
    const prepared = await prepareVersionArtifacts(input);
    const { unitBytes, configBytes } = prepared;
    const unitIdentity = await atomicWrite(
      input.ports.fileSystem,
      generation.unitPath,
      unitBytes,
      0o444,
      null,
      input.ports.ids.nextId(),
    );
    created.push({ path: generation.unitPath, identity: unitIdentity, kind: 'file' });
    requireOwnedFile(unitIdentity, input.expectedUid, 0o444, 'version unit backup');
    const configIdentity = await atomicWrite(
      input.ports.fileSystem,
      generation.configPath,
      configBytes,
      0o400,
      null,
      input.ports.ids.nextId(),
    );
    created.push({ path: generation.configPath, identity: configIdentity, kind: 'file' });
    requireOwnedFile(configIdentity, input.expectedUid, 0o400, 'version config backup');
    return {
      version: {
        version: input.version,
        image: input.image,
        unitSha256: prepared.unitSha256,
        configSha256: prepared.configSha256,
        unitBackupPath: generation.unitPath,
        configBackupPath: generation.configPath,
        fullResources: input.topology === 'full' ? input.fullResources as FullResourceSpec : null,
        createdAtMs: input.ports.clock.nowMs(),
      },
      unitBytes,
      configBytes,
      unitIdentity,
      configIdentity,
      created,
    };
  } catch (error) {
    await cleanupCreatedPaths(input.ports.fileSystem, created);
    throw error;
  }
}

export async function readVersionArtifacts(input: {
  readonly ports: InstanceManagerPorts;
  readonly version: ManagedVersion;
  readonly maxArtifactBytes: number;
  readonly expectedUid: number;
}): Promise<{ readonly unitBytes: Uint8Array; readonly configBytes: Uint8Array }> {
  if (posix.dirname(input.version.unitBackupPath) !== posix.dirname(input.version.configBackupPath)) fail('tampered', 'version artifacts do not share one exact generation directory');
  await requireOwnedDirectory(input.ports.fileSystem, posix.dirname(input.version.unitBackupPath), input.expectedUid, 0o700, 'version generation directory');
  const unit = await requireCanonicalFile(
    input.ports.fileSystem,
    input.version.unitBackupPath,
    input.maxArtifactBytes,
    'version unit backup',
  );
  const config = await requireCanonicalFile(
    input.ports.fileSystem,
    input.version.configBackupPath,
    input.maxArtifactBytes,
    'version config backup',
  );
  requireOwnedFile(unit.identity, input.expectedUid, 0o444, 'version unit backup');
  requireOwnedFile(config.identity, input.expectedUid, 0o400, 'version config backup');
  const imageLines = decodeUtf8(unit.bytes, 'version unit backup').match(/^Image=(.+)$/gm) ?? [];
  if (imageLines.length !== 1 || imageLines[0] !== `Image=${input.version.image}`) {
    fail('tampered', 'version unit backup image does not match its pinned record');
  }
  if (
    sha256(unit.bytes) !== input.version.unitSha256 ||
    sha256(config.bytes) !== input.version.configSha256
  ) {
    fail('tampered', 'version backup checksum mismatch');
  }
  return { unitBytes: unit.bytes, configBytes: config.bytes };
}
