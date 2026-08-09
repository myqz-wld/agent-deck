import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';

const MAX_RUNTIME_DIRECTORIES = 8;

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

function validateTarget(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.includes('\0') ||
      Buffer.byteLength(path) > 4_096) {
    throw new Error('provider runtime directory path is invalid');
  }
}

function requireCanonicalDirectory(path: string, uid?: number): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700))) {
    throw new Error('provider runtime directory identity is invalid');
  }
}

function prepareDirectory(path: string, uid: number): void {
  const missing: string[] = [];
  let cursor = path;
  while (!lstatSync(cursor, { throwIfNoEntry: false })) {
    missing.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('provider runtime directory parent is unavailable');
    cursor = parent;
  }
  requireCanonicalDirectory(cursor);
  for (const target of missing) {
    mkdirSync(target, { mode: 0o700 });
    requireCanonicalDirectory(target, uid);
  }
  requireCanonicalDirectory(path, uid);
}

/** Creates only the exact private runtime roots and rejects symlink/owner/mode substitution. */
export function prepareProviderSessionRuntimeDirectories(
  paths: readonly string[],
  uid = currentUid(),
): void {
  if (!Number.isSafeInteger(uid) || uid <= 0 || paths.length < 1 ||
      paths.length > MAX_RUNTIME_DIRECTORIES) {
    throw new Error('provider runtime directory authority is invalid');
  }
  const targets = [...new Set(paths)];
  if (targets.length !== paths.length) {
    throw new Error('provider runtime directory set is invalid');
  }
  for (const path of targets) validateTarget(path);
  for (const path of targets.sort((left, right) => left.length - right.length)) {
    prepareDirectory(path, uid);
  }
}
