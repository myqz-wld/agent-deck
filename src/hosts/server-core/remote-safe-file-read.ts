import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { relative, sep } from 'node:path';

export interface RemoteSafeFileReadOptions {
  readonly maximumBytes: number;
  readonly root: string;
  readonly sensitive: (path: string) => boolean;
}

export interface RemoteSafeFileReadResult {
  readonly canonicalPath: string;
  readonly content: string;
}

interface RemoteSafeFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  isFile(): boolean;
}

export interface RemoteSafeFileFilesystem {
  close(descriptor: number): void;
  fstat(descriptor: number): RemoteSafeFileStat;
  open(path: string, flags: number): number;
  read(descriptor: number): string;
  realpath(path: string): string;
  stat(path: string): RemoteSafeFileStat;
}

const filesystem: RemoteSafeFileFilesystem = {
  close: closeSync,
  fstat: fstatSync,
  open: openSync,
  read: (descriptor) => readFileSync(descriptor, 'utf8'),
  realpath: realpathSync,
  stat: statSync,
};

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function sameFile(
  opened: RemoteSafeFileStat,
  current: RemoteSafeFileStat,
): boolean {
  return opened.dev === current.dev && opened.ino === current.ino;
}

/**
 * Opens one already-allowlisted file once and reads only through that descriptor.
 * The post-open identity check closes canonical-path and final-symlink replacement races.
 */
export function readRemoteSafeFile(
  path: string,
  options: RemoteSafeFileReadOptions,
  fs: RemoteSafeFileFilesystem = filesystem,
): RemoteSafeFileReadResult | null {
  if (options.sensitive(path)) return null;
  let descriptor: number | null = null;
  try {
    const canonicalPath = fs.realpath(path);
    if (options.sensitive(canonicalPath) || !inside(options.root, canonicalPath)) return null;
    descriptor = fs.open(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstat(descriptor);
    if (!opened.isFile() || opened.size > options.maximumBytes) return null;
    const currentPath = fs.realpath(canonicalPath);
    const current = fs.stat(currentPath);
    if (
      options.sensitive(currentPath) || !inside(options.root, currentPath) ||
      !sameFile(opened, current)
    ) return null;
    const content = fs.read(descriptor);
    if (Buffer.byteLength(content, 'utf8') > options.maximumBytes) return null;
    return Object.freeze({ canonicalPath, content });
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { fs.close(descriptor); } catch {}
    }
  }
}
