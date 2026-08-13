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
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

export const MAX_PROVIDER_FILE_BYTES = 1024 * 1024;
export type ProviderProjectionMode = 'create-only' | 'replace';

function relativeProviderPath(value: string): string {
  const normalized = normalize(value);
  if (
    !value || isAbsolute(value) || normalized !== value || normalized === '..' ||
    normalized.startsWith(`..${sep}`)
  ) throw new Error('provider projection path is invalid');
  return normalized;
}

export function canonicalProviderDirectory(
  path: string,
  field: string,
  requirePrivate: boolean,
): string {
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
    throw new Error(`${field} is not ${requirePrivate ? 'private and ' : ''}user-owned`);
  }
  return path;
}

function sameFile(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function readOptionalProviderFile(
  root: string,
  relativePath: string,
  options: { readonly private?: boolean; readonly maxBytes?: number } = {},
): Buffer | null {
  const path = join(root, relativeProviderPath(relativePath));
  const pathStat = lstatSync(path, { throwIfNoEntry: false });
  if (!pathStat) return null;
  if (realpathSync(path) !== path) throw new Error('provider source file is not canonical');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !pathStat.isFile() || pathStat.isSymbolicLink() ||
    pathStat.size > (options.maxBytes ?? MAX_PROVIDER_FILE_BYTES) ||
    (pathStat.mode & (options.private === true ? 0o077 : 0o022)) !== 0 ||
    (uid !== null && pathStat.uid !== uid)
  ) throw new Error('provider source file trust check failed');
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
  ) throw new Error('provider destination file trust check failed');
}

function ensurePrivateParent(root: string, relativePath: string): void {
  const parent = dirname(relativeProviderPath(relativePath));
  if (parent === '.') return;
  let current = root;
  for (const component of parent.split(sep)) {
    current = join(current, component);
    if (!lstatSync(current, { throwIfNoEntry: false })) mkdirSync(current, { mode: 0o700 });
    canonicalProviderDirectory(current, 'provider destination directory', true);
  }
}

export function writeProviderFile(
  root: string,
  relativePath: string,
  bytes: Buffer,
  mode: ProviderProjectionMode,
): void {
  const relative = relativeProviderPath(relativePath);
  ensurePrivateParent(root, relative);
  const path = join(root, relative);
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

export function removeProviderFile(root: string, relativePath: string): void {
  const path = join(root, relativeProviderPath(relativePath));
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  assertDestinationFile(path);
  unlinkSync(path);
  syncDirectory(dirname(path));
}
