import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { PAYLOAD_LIMITS } from '@main/store/payload-truncate';

const MAX_PATH_BYTES = 4_096;
const MAX_ANCESTORS = 256;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileChangeCaptureFilesystem {
  close(descriptor: number): void;
  fstat(descriptor: number): FileIdentity;
  lstat(path: string): FileIdentity;
  open(path: string, flags: number): number;
  read(descriptor: number): string;
  realpath(path: string): string;
  stat(path: string): FileIdentity;
}

const filesystem: FileChangeCaptureFilesystem = {
  close: closeSync,
  fstat: fstatSync,
  lstat: lstatSync,
  open: openSync,
  read: (descriptor) => readFileSync(descriptor, 'utf8'),
  realpath: realpathSync,
  stat: statSync,
};

export interface FileChangePathCapture {
  readonly authority: string | null;
  readonly afterSnapshot: string | null;
}

function boundedPath(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES &&
    !CONTROL.test(value);
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function resolveAuthority(
  cwd: string | null,
  filePath: string,
  fs: Pick<FileChangeCaptureFilesystem, 'lstat' | 'realpath'>,
): { authority: string; exists: boolean; requested: string } | null {
  if (!cwd || !boundedPath(cwd) || !boundedPath(filePath) || !isAbsolute(cwd)) return null;
  try {
    fs.realpath(resolve(cwd));
  } catch {
    return null;
  }
  const requested = resolve(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
  let candidate = requested;
  const missingSegments: string[] = [];
  for (let attempt = 0; attempt < MAX_ANCESTORS; attempt += 1) {
    try {
      return {
        authority: resolve(fs.realpath(candidate), ...missingSegments),
        exists: missingSegments.length === 0,
        requested,
      };
    } catch (error) {
      if (!missing(error)) return null;
      try {
        if (fs.lstat(candidate).isSymbolicLink()) return null;
      } catch (lstatError) {
        if (!missing(lstatError)) return null;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
  return null;
}

/** Captures one canonical identity and reads text only after the opened inode still matches it. */
export function captureFileChangePath(
  cwd: string | null,
  filePath: string,
  captureText: boolean,
  fs: FileChangeCaptureFilesystem = filesystem,
): FileChangePathCapture {
  const resolved = resolveAuthority(cwd, filePath, fs);
  if (!resolved) return { authority: null, afterSnapshot: null };
  if (!captureText || !resolved.exists) {
    return { authority: resolved.authority, afterSnapshot: null };
  }

  let descriptor: number | null = null;
  try {
    descriptor = fs.open(
      resolved.authority,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstat(descriptor);
    if (!opened.isFile()) return { authority: null, afterSnapshot: null };
    const currentRequested = fs.realpath(resolved.requested);
    const currentAuthorized = fs.realpath(resolved.authority);
    const current = fs.stat(currentAuthorized);
    if (
      currentRequested !== resolved.authority ||
      currentAuthorized !== resolved.authority ||
      !sameFile(opened, current)
    ) return { authority: null, afterSnapshot: null };
    if (opened.size > PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES) {
      return { authority: resolved.authority, afterSnapshot: null };
    }
    const afterSnapshot = fs.read(descriptor);
    if (Buffer.byteLength(afterSnapshot, 'utf8') > PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES) {
      return { authority: resolved.authority, afterSnapshot: null };
    }
    return { authority: resolved.authority, afterSnapshot };
  } catch {
    return { authority: null, afterSnapshot: null };
  } finally {
    if (descriptor !== null) {
      try { fs.close(descriptor); } catch {}
    }
  }
}
