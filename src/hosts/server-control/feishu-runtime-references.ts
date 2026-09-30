import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

function vanished(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
}

/** Any unreadable live process makes pruning unavailable, never less conservative. */
export function liveFeishuRuntimeDigests(releases: string): ReadonlySet<string> {
  if (process.platform !== 'linux') throw new Error('Runtime process inspection requires Linux');
  const result = new Set<string>();
  const observe = (value: string): void => {
    if (!value.startsWith(`${releases}/`)) return;
    const digest = value.slice(releases.length + 1).split('/')[0];
    if (/^[a-f0-9]{64}$/u.test(digest)) result.add(digest);
  };
  for (const pid of readdirSync('/proc').filter(name => /^[0-9]+$/u.test(name))) {
    const root = join('/proc', pid);
    for (const name of ['exe', 'cwd']) {
      try { observe(readlinkSync(join(root, name))); } catch (error) {
        if (!vanished(error)) throw error;
      }
    }
    try {
      for (const line of readFileSync(join(root, 'maps'), 'utf8').split('\n')) {
        const path = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/u)?.[1];
        if (path) observe(path.replace(/\\([0-7]{3})/gu,
          (_, value: string) => String.fromCharCode(parseInt(value, 8))));
      }
      for (const fd of readdirSync(join(root, 'fd'))) {
        try { observe(readlinkSync(join(root, 'fd', fd))); } catch (error) {
          if (!vanished(error)) throw error;
        }
      }
    } catch (error) {
      if (!vanished(error)) throw error;
    }
  }
  return result;
}
