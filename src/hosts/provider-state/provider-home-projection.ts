import { randomUUID } from 'node:crypto';
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
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_PROVIDER_FILE_BYTES = 1024 * 1024;
export const PROVIDER_HOME_AUTH_FILES = Object.freeze([
  '.claude/.credentials.json',
  '.codex/auth.json',
] as const);
const RETIRED_PROVIDER_HOME_AUTH_FILES = Object.freeze([
  '.grok/auth.json',
] as const);

type ProjectionMode = 'create-only' | 'replace';

function canonicalDirectory(path: string, field: string, requirePrivate: boolean): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error(`${field} must be one canonical directory`);
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (stat.mode & (requirePrivate ? 0o077 : 0o022)) !== 0 ||
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
    pathStat.size > MAX_PROVIDER_FILE_BYTES || (pathStat.mode & 0o077) !== 0 ||
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

function ensurePrivateDirectory(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
  canonicalDirectory(path, 'provider destination directory', true);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertDestinationFile(path: string): void {
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid)
  ) {
    throw new Error('provider destination file trust check failed');
  }
}

function writePrivateFile(path: string, bytes: Buffer, mode: ProjectionMode): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing) {
    assertDestinationFile(path);
    if (mode === 'create-only') throw new Error('provider destination file already exists');
  }
  const temporary = `${path}.agent-deck-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
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
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    assertDestinationFile(path);
    syncDirectory(dirname(path));
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function removePrivateFile(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  assertDestinationFile(path);
  unlinkSync(path);
  syncDirectory(dirname(path));
}

export function projectProviderHomeAuthFiles(
  sourceHome: string,
  destinationHome: string,
  mode: ProjectionMode = 'create-only',
): readonly string[] {
  const source = canonicalDirectory(sourceHome, 'provider source home', false);
  const destination = canonicalDirectory(destinationHome, 'provider destination home', true);
  const projected: string[] = [];
  for (const relativePath of RETIRED_PROVIDER_HOME_AUTH_FILES) {
    removePrivateFile(join(destination, relativePath));
  }
  for (const relativePath of PROVIDER_HOME_AUTH_FILES) {
    const bytes = readOptionalPrivateFile(join(source, relativePath));
    const destinationFile = join(destination, relativePath);
    if (!bytes) {
      if (mode === 'replace') removePrivateFile(destinationFile);
      continue;
    }
    try {
      ensurePrivateDirectory(dirname(destinationFile));
      writePrivateFile(destinationFile, bytes, mode);
      projected.push(relativePath);
    } finally {
      bytes.fill(0);
    }
  }
  return Object.freeze(projected);
}

/** Replace the exact auth projection; a missing source removes stale projected credentials. */
export function syncProviderHomeAuthFiles(
  sourceHome: string | null,
  destinationHome: string,
): readonly string[] {
  if (sourceHome !== null) {
    return projectProviderHomeAuthFiles(sourceHome, destinationHome, 'replace');
  }
  const destination = canonicalDirectory(destinationHome, 'provider destination home', true);
  for (const relativePath of [
    ...PROVIDER_HOME_AUTH_FILES,
    ...RETIRED_PROVIDER_HOME_AUTH_FILES,
  ]) {
    removePrivateFile(join(destination, relativePath));
  }
  return Object.freeze([]);
}
