import { homedir } from 'node:os';
import { dirname } from 'node:path';

/** Find the nearest safe existing parent without crossing the home or filesystem-root boundary. */
export function findFallbackCwd(
  badCwd: string,
  cwdExistsThunk: (p: string) => boolean,
): string | null {
  const home = homedir();
  let p = dirname(badCwd);
  for (let i = 0; i < 32; i++) {
    const isAncestorOfHome = home === p || home.startsWith(p + '/');
    if (p === '/' || isAncestorOfHome || p.length <= 1) return null;
    if (cwdExistsThunk(p)) return p;
    const next = dirname(p);
    if (next === p) return null;
    p = next;
  }
  return null;
}
