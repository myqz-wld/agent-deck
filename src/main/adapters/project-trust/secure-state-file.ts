import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ProjectTrustReasonCode } from '@shared/types';

export const PROJECT_TRUST_MAX_STATE_BYTES = 1024 * 1024;

export class ProjectTrustStateError extends Error {
  constructor(readonly reasonCode: ProjectTrustReasonCode) {
    super(reasonCode);
    this.name = 'ProjectTrustStateError';
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function owned(stat: Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === null || stat.uid === uid;
}

function noFollow(): number {
  return constants.O_NOFOLLOW ?? 0;
}

export function readSecureOptionalText(
  path: string,
  maxBytes = PROJECT_TRUST_MAX_STATE_BYTES,
): { readonly text: string; readonly version: string } | null {
  let beforePath: Stats;
  try {
    beforePath = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ProjectTrustStateError('state-unreadable');
  }
  if (
    !beforePath.isFile() || beforePath.isSymbolicLink() || !owned(beforePath) ||
    (beforePath.mode & 0o022) !== 0 || beforePath.size > maxBytes
  ) throw new ProjectTrustStateError('state-unsafe');

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow() | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new ProjectTrustStateError('state-unreadable');
  }
  try {
    const before = fstatSync(descriptor);
    if (before.size > maxBytes) throw new ProjectTrustStateError('state-unsafe');
    // Read at most the observed size plus one sentinel byte. A concurrent writer can otherwise
    // grow a provider state file after lstat/fstat and turn a bounded metadata read into an
    // unbounded allocation before the identity check notices the race.
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      !sameFile(beforePath, before) || !sameFile(before, after) ||
      offset !== before.size
    ) throw new ProjectTrustStateError('state-unsafe');
    return {
      text: bytes.subarray(0, offset).toString('utf8'),
      version: `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`,
    };
  } catch (error) {
    if (error instanceof ProjectTrustStateError) throw error;
    throw new ProjectTrustStateError('state-unreadable');
  } finally {
    closeSync(descriptor);
  }
}

function requireSafeDirectory(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ProjectTrustStateError('state-unreadable');
  }
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) ||
    (stat.mode & 0o022) !== 0 || realpathSync.native(path) !== resolve(path)
  ) throw new ProjectTrustStateError('state-unsafe');
}

function ensureSafeParent(path: string): string {
  const parent = dirname(path);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch {
    throw new ProjectTrustStateError('state-unreadable');
  }
  requireSafeDirectory(parent);
  return parent;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export function writeAtomicPrivateText(path: string, body: string): void {
  if (Buffer.byteLength(body, 'utf8') > PROJECT_TRUST_MAX_STATE_BYTES) {
    throw new ProjectTrustStateError('state-unsafe');
  }
  const parent = ensureSafeParent(path);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && (
    !existing.isFile() || existing.isSymbolicLink() || !owned(existing) ||
    (existing.mode & 0o022) !== 0
  )) throw new ProjectTrustStateError('state-unsafe');

  const temporary = `${path}.agent-deck-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
    0o600,
  );
  try {
    const bytes = Buffer.from(body, 'utf8');
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== bytes.byteLength || (stat.mode & 0o777) !== 0o600) {
      throw new ProjectTrustStateError('state-unreadable');
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    const published = statSync(path);
    if (!published.isFile() || !owned(published) || (published.mode & 0o777) !== 0o600) {
      throw new ProjectTrustStateError('state-unsafe');
    }
    syncDirectory(parent);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

/** Participate in Claude's native atomic directory-lock protocol. */
export async function withDirectoryLock<T>(
  lockPath: string,
  operation: () => Promise<T> | T,
  timeoutMs = 1_500,
): Promise<T> {
  ensureSafeParent(lockPath);
  const deadline = Date.now() + timeoutMs;
  let identity: { dev: number; ino: number } | null = null;
  while (!identity) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const stat = lstatSync(lockPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
        throw new ProjectTrustStateError('state-unsafe');
      }
      identity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if (error instanceof ProjectTrustStateError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) {
        throw new ProjectTrustStateError('state-unreadable');
      }
      await delay(25);
    }
  }
  try {
    return await operation();
  } finally {
    try {
      const current = lstatSync(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) rmdirSync(lockPath);
    } catch {
      // Never remove a replaced lock; the writer has already completed or failed.
    }
  }
}
