import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { FileChangePathAuthority } from '@shared/file-change-path-authority';
import { isRemoteSensitiveWorkspacePath } from './remote-sensitive-data';

const MAX_ANCESTORS = 256;

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function projectedPath(root: string, target: string): string | null {
  if (!inside(root, target)) return null;
  const projected = relative(root, target).split(sep).join('/');
  return projected && !isRemoteSensitiveWorkspacePath(projected) ? projected : null;
}

function currentCanonicalTarget(
  requested: string,
  canonicalize: (path: string) => string,
): string | null {
  let candidate = requested;
  const missingSegments: string[] = [];
  for (let attempt = 0; attempt < MAX_ANCESTORS; attempt += 1) {
    try {
      return resolve(canonicalize(candidate), ...missingSegments);
    } catch (error) {
      if (!missing(error)) return null;
      try {
        if (lstatSync(candidate).isSymbolicLink()) return null;
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

export function projectSessionFilePath(input: {
  authority: FileChangePathAuthority;
  canonicalize: (path: string) => string;
  cwd: string;
  filePath: string;
  workspaceRoot: string;
}): string | null {
  const requested = resolve(isAbsolute(input.filePath)
    ? input.filePath
    : resolve(input.cwd, input.filePath));
  if (projectedPath(input.workspaceRoot, requested) === null) return null;

  if (input.authority === null) return null;
  const authorized = resolve(input.authority);
  const projected = projectedPath(input.workspaceRoot, authorized);
  if (projected === null) return null;
  if (currentCanonicalTarget(requested, input.canonicalize) !== authorized) return null;
  return projected;
}
