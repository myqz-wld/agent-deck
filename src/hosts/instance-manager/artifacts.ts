import { posix } from 'node:path';

import type { ExactTreeSnapshot, FileIdentity, FileSystemPort, TrustedFileArtifact } from './types';
import { sha256 } from './serialization';
import type { InstanceManagerContext } from './context';
import {
  fail,
  sameFileSnapshot,
  sameIdentity,
  validateChildPath,
  validateOperationId,
} from './validation';

export interface CreatedPath {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly kind: 'directory' | 'file';
}

export async function requireCanonicalDirectory(
  fileSystem: FileSystemPort,
  path: string,
  field: string,
): Promise<FileIdentity> {
  const identity = await fileSystem.lstat(path);
  if (!identity || identity.kind !== 'directory') fail('tampered', `${field} is not a directory`);
  if ((await fileSystem.realpath(path)) !== path) fail('tampered', `${field} uses symlink indirection`);
  return identity;
}

export async function requireOwnedDirectory(
  fileSystem: FileSystemPort,
  path: string,
  expectedUid: number,
  expectedMode: number,
  field: string,
): Promise<FileIdentity> {
  const identity = await requireCanonicalDirectory(fileSystem, path, field);
  if (identity.uid !== expectedUid || (identity.mode & 0o777) !== expectedMode) {
    fail('tampered', `${field} has an unexpected owner or mode`);
  }
  return identity;
}

export async function requireCanonicalFile(
  fileSystem: FileSystemPort,
  path: string,
  maxBytes: number,
  field: string,
): Promise<{ readonly bytes: Uint8Array; readonly identity: FileIdentity }> {
  const identity = await fileSystem.lstat(path);
  if (!identity || identity.kind !== 'file' || identity.size > maxBytes) {
    fail('tampered', `${field} is not a bounded regular file`);
  }
  if ((await fileSystem.realpath(path)) !== path) fail('tampered', `${field} uses symlink indirection`);
  const bytes = await fileSystem.readFile(path, maxBytes);
  if (bytes.byteLength !== identity.size) fail('tampered', `${field} changed while it was read`);
  const after = await fileSystem.lstat(path);
  if (!after || !sameFileSnapshot(identity, after)) {
    fail('tampered', `${field} identity changed while it was read`);
  }
  return { bytes, identity };
}

export async function captureTrustedFile(
  fileSystem: FileSystemPort,
  path: string,
  maxBytes: number,
  expectedUid: number,
  expectedMode: number,
  field: string,
): Promise<TrustedFileArtifact> {
  const artifact = await requireCanonicalFile(fileSystem, path, maxBytes, field);
  if (artifact.identity.uid !== expectedUid || (artifact.identity.mode & 0o777) !== expectedMode) {
    fail('tampered', `${field} has an unexpected trusted owner or mode`);
  }
  return { path, identity: artifact.identity, sha256: sha256(artifact.bytes) };
}

async function requireTrustedAncestors(
  fileSystem: FileSystemPort,
  path: string,
  allowedUids: readonly number[],
  field: string,
): Promise<void> {
  const filesystemRoot = await requireCanonicalDirectory(fileSystem, '/', field);
  if (!allowedUids.includes(filesystemRoot.uid) || (filesystemRoot.mode & 0o022) !== 0) {
    fail('tampered', `${field} has an untrusted filesystem root ancestor`);
  }
  let current = '/';
  for (const segment of path.split('/').filter(Boolean)) {
    current = posix.join(current, segment);
    const identity = await requireCanonicalDirectory(fileSystem, current, field);
    if (!allowedUids.includes(identity.uid) || (identity.mode & 0o022) !== 0) {
      fail('tampered', `${field} has an untrusted writable ancestor`);
    }
  }
}

export async function validateManagerRoots(context: InstanceManagerContext): Promise<void> {
  const { fileSystem } = context.ports;
  const { roots } = context;
  for (const [field, path, uid, mode] of [
    ['serviceHome', roots.serviceHome, context.serviceUid, 0o700],
    ['runtimeRoot', roots.runtimeRoot, context.serviceUid, 0o700],
    ['unitRoot', roots.unitRoot, context.serviceUid, 0o700],
    ['metadataRoot', roots.metadataRoot, context.serviceUid, 0o700],
    ['backupRoot', roots.backupRoot, context.serviceUid, 0o700],
    ['journalRoot', roots.journalRoot, context.serviceUid, 0o700],
    ['relayEvidenceRoot', roots.relayEvidenceRoot, context.trustedRootUid, 0o555],
    ['cutoverEvidenceRoot', roots.cutoverEvidenceRoot, context.trustedRootUid, 0o555],
  ] as const) {
    await requireTrustedAncestors(fileSystem, posix.dirname(path), [context.trustedRootUid, context.serviceUid], `roots.${field}`);
    const identity = await requireCanonicalDirectory(fileSystem, path, `roots.${field}`);
    if (identity.uid !== uid || (identity.mode & 0o777) !== mode) {
      fail('tampered', `roots.${field} has an unexpected owner or mode`);
    }
  }
  for (const [field, path, mode] of [
    ['fullTemplatePath', roots.fullTemplatePath, 0o444],
    ['fullPreflightPath', roots.fullPreflightPath, 0o555],
    ['relayTemplatePath', roots.relayTemplatePath, 0o444],
    ['relayPreflightPath', roots.relayPreflightPath, 0o555],
  ] as const) {
    await requireTrustedAncestors(fileSystem, posix.dirname(path), [context.trustedRootUid], `roots.${field}`);
    const identity = await fileSystem.lstat(path);
    if (
      !identity || identity.kind !== 'file' || identity.uid !== context.trustedArtifactUid ||
      (identity.mode & 0o777) !== mode || (await fileSystem.realpath(path)) !== path
    ) {
      fail('tampered', `roots.${field} must be an exact regular non-symlink file`);
    }
  }
}

export async function ensureDirectoryChain(
  fileSystem: FileSystemPort,
  root: string,
  target: string,
  created: CreatedPath[],
  expectedUid: number,
  expectedMode = 0o700,
): Promise<FileIdentity> {
  validateChildPath(target, root, 'directory target');
  await requireCanonicalDirectory(fileSystem, root, 'directory root');
  let current = root;
  for (const segment of posix.relative(root, target).split('/')) {
    current = posix.join(current, segment);
    const existing = await fileSystem.lstat(current);
    if (existing) {
      if (
        existing.kind !== 'directory' || existing.uid !== expectedUid ||
        (existing.mode & 0o777) !== expectedMode || (await fileSystem.realpath(current)) !== current
      ) {
        fail('tampered', `directory path is not canonical: ${current}`);
      }
      continue;
    }
    const identity = await fileSystem.createDirectory(current, expectedMode);
    const observed = await fileSystem.lstat(current);
    if (
      !observed || !sameIdentity(identity, observed) || observed.kind !== 'directory' ||
      observed.uid !== expectedUid || (observed.mode & 0o777) !== expectedMode
    ) {
      fail('tampered', `created directory identity mismatch: ${current}`);
    }
    created.push({ path: current, identity, kind: 'directory' });
  }
  return requireCanonicalDirectory(fileSystem, target, 'created directory');
}

export async function atomicWrite(
  fileSystem: FileSystemPort,
  targetPath: string,
  data: Uint8Array,
  mode: number,
  expectedTarget: FileIdentity | null,
  operationId: string,
): Promise<FileIdentity> {
  validateOperationId(operationId);
  const stagedPath = posix.join(posix.dirname(targetPath), `.${posix.basename(targetPath)}.${operationId}.tmp`);
  if (await fileSystem.lstat(stagedPath)) fail('conflict', 'atomic staging path already exists');
  const staged = await fileSystem.createFileExclusive(stagedPath, data, mode);
  try {
    return await fileSystem.replaceFileAtomic(stagedPath, targetPath, expectedTarget);
  } catch (error) {
    const observed = await fileSystem.lstat(stagedPath);
    if (observed && sameIdentity(observed, staged)) {
      await fileSystem.removeFileExact(stagedPath, staged);
    }
    throw error;
  }
}

export async function cleanupCreatedPaths(
  fileSystem: FileSystemPort,
  created: readonly CreatedPath[],
): Promise<void> {
  for (const entry of [...created].reverse()) {
    const observed = await fileSystem.lstat(entry.path);
    if (!observed) continue;
    if (!sameIdentity(observed, entry.identity)) fail('recovery_required', 'created resource identity changed during cleanup');
    if (entry.kind === 'file') await fileSystem.removeFileExact(entry.path, entry.identity);
    else {
      const children = await fileSystem.listDirectory(entry.path, 10_000);
      if (children.length === 0) {
        await fileSystem.removeDirectoryExact(entry.path, entry.identity);
      } else fail('recovery_required', 'created directory gained uncertain residual entries');
    }
  }
}

export async function snapshotTreeForRemoval(
  fileSystem: FileSystemPort,
  root: string,
  maxEntries = 10_000,
): Promise<ExactTreeSnapshot> {
  const rootIdentity = await requireCanonicalDirectory(fileSystem, root, 'removal root');
  const snapshot = await fileSystem.captureTreeExact(root, maxEntries);
  if (snapshot.rootPath !== root || !sameFileSnapshot(snapshot.rootIdentity, rootIdentity)) {
    fail('tampered', 'removal root changed while its exact tree was captured');
  }
  validateExactTreeSnapshot(snapshot, maxEntries);
  return snapshot;
}

export function validateExactTreeSnapshot(snapshot: ExactTreeSnapshot, maxEntries = 10_000): void {
  if (snapshot.rootIdentity.kind !== 'directory') fail('tampered', 'removal snapshot root is not a directory');
  if (snapshot.entries.length > maxEntries) fail('tampered', 'removal tree exceeds the entry bound');
  const observed = new Set<string>();
  for (const entry of snapshot.entries) {
    const relative = entry.relativePath;
    if (
      !relative || relative.includes('\u0000') || posix.isAbsolute(relative) ||
      posix.normalize(relative) !== relative || relative === '..' || relative.startsWith('../') ||
      Buffer.byteLength(relative, 'utf8') > 4_096 ||
      observed.has(relative)
    ) fail('tampered', 'removal snapshot contains an unsafe or duplicate path');
    observed.add(relative);
    if (entry.identity.device !== snapshot.rootIdentity.device) fail('tampered', 'removal tree crosses a device boundary');
    if (entry.identity.kind !== 'file' && entry.identity.kind !== 'directory') {
      fail('tampered', 'removal tree contains a symlink or special entry');
    }
  }
}
