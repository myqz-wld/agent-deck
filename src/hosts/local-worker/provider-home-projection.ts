import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_PROVIDER_FILE_BYTES = 1024 * 1024;
const PROVIDER_FILES = Object.freeze([
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.grok/auth.json',
] as const);

function canonicalDirectory(path: string, field: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error(`${field} must be one canonical directory`);
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (uid !== null && stat.uid !== uid)
  ) {
    throw new Error(`${field} is not private and user-owned`);
  }
  return path;
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readOptionalPrivateFile(path: string): Buffer | null {
  const pathStat = lstatSync(path, { throwIfNoEntry: false });
  if (!pathStat) return null;
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('provider source file is not canonical');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !pathStat.isFile() || pathStat.isSymbolicLink() ||
    pathStat.size > MAX_PROVIDER_FILE_BYTES || (pathStat.mode & 0o022) !== 0 ||
    (uid !== null && pathStat.uid !== uid)
  ) {
    throw new Error('provider source file trust check failed');
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameFile(pathStat, before) || !sameFile(before, after) || bytes.byteLength !== before.size) {
      bytes.fill(0);
      throw new Error('provider source file changed while it was read');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  canonicalDirectory(path, 'provider destination directory');
}

function writePrivateFile(path: string, bytes: Buffer): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== bytes.byteLength || (stat.mode & 0o777) !== 0o600) {
      throw new Error('provider destination file verification failed');
    }
  } finally {
    closeSync(descriptor);
  }
}

export function projectLocalWorkerProviderHome(
  sourceHome: string,
  destinationHome: string,
): readonly string[] {
  const source = canonicalDirectory(sourceHome, 'provider source home');
  const destination = canonicalDirectory(destinationHome, 'provider destination home');
  const createdDirectories = new Set<string>();
  const projected: string[] = [];
  for (const relativePath of PROVIDER_FILES) {
    const bytes = readOptionalPrivateFile(join(source, relativePath));
    if (!bytes) continue;
    try {
      const destinationDirectory = dirname(join(destination, relativePath));
      if (!createdDirectories.has(destinationDirectory)) {
        createPrivateDirectory(destinationDirectory);
        createdDirectories.add(destinationDirectory);
      }
      writePrivateFile(join(destination, relativePath), bytes);
      projected.push(relativePath);
    } finally {
      bytes.fill(0);
    }
  }
  return Object.freeze(projected);
}
