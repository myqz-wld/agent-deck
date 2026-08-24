import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function canonicalProjectDirectory(path: string): string {
  const canonical = realpathSync.native(resolve(path));
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('project directory is unavailable');
  }
  return canonical;
}

export function isPathWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

export function findProjectRoot(cwd: string, markers: readonly string[]): string {
  let current = cwd;
  while (true) {
    if (markers.some((marker) => {
      try {
        const stat = lstatSync(join(current, marker));
        return stat.isFile() || stat.isDirectory();
      }
      catch { return false; }
    })) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function readSmallGitPath(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Resolve the conventional main checkout root used by Codex and Grok trust. */
export function resolveMainGitCheckout(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const dotGit = join(current, '.git');
    let stat;
    try { stat = lstatSync(dotGit); } catch { stat = null; }
    if (stat?.isDirectory() && !stat.isSymbolicLink()) return current;
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      const pointer = readSmallGitPath(dotGit);
      const match = pointer ? /^gitdir:\s*(.+)$/i.exec(pointer) : null;
      if (!match) return current;
      const gitDir = realpathSync.native(resolve(current, match[1]!));
      const commonRef = readSmallGitPath(join(gitDir, 'commondir'));
      if (!commonRef) return current;
      const commonDir = realpathSync.native(resolve(gitDir, commonRef));
      if (dirname(gitDir) !== join(commonDir, 'worktrees')) return current;
      const main = dirname(commonDir);
      try {
        const mainDotGit = lstatSync(join(main, '.git'));
        if (mainDotGit.isDirectory() && !mainDotGit.isSymbolicLink() &&
            realpathSync.native(join(main, '.git')) === commonDir) return realpathSync.native(main);
      } catch {}
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
