import { posix, win32 } from 'node:path';

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

/** Classify absolute paths using the target platform's syntax, not the test host's syntax. */
export function isPlatformAbsolutePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathApi(platform).isAbsolute(value);
}

/** Require a canonical candidate to be a descendant of a canonical root. */
export function isPathWithinRoot(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApi(platform);
  const relative = api.relative(root, candidate);
  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative);
}
