import { constants } from 'node:fs';
import { open, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { requireAbsolutePath } from './validation';

type RuntimeStat = Awaited<ReturnType<FileHandle['stat']>>;

export interface TrustedRuntimeModulePorts {
  readonly platform: NodeJS.Platform;
  readonly currentUid: () => number | null;
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<RuntimeStat>;
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
  readonly importModule: (url: string) => Promise<unknown>;
}

const PRODUCTION_PORTS: TrustedRuntimeModulePorts = Object.freeze({
  platform: process.platform,
  currentUid: () => typeof process.getuid === 'function' ? process.getuid() : null,
  realpath,
  lstat,
  open,
  importModule: (url: string) => import(url),
});

function sameIdentity(left: RuntimeStat, right: RuntimeStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** Test seams are created here; production callers use the fixed Linux-only export below. */
export function createTrustedRuntimeModuleLoader(
  ports: TrustedRuntimeModulePorts,
): (path: string) => Promise<Record<string, unknown>> {
  return async (path: string): Promise<Record<string, unknown>> => {
    requireAbsolutePath(path, 'runtimeModule');
    if (ports.platform !== 'linux') {
      throw new Error('trusted runtime modules require Linux descriptor imports');
    }
    let handle: FileHandle | undefined;
    try {
      if ((await ports.realpath(path)) !== path) {
        throw new Error('runtime module path is not canonical');
      }
      handle = await ports.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await handle.stat();
      const currentUid = ports.currentUid();
      if (
        !before.isFile() ||
        (before.mode & 0o022) !== 0 ||
        (currentUid !== null && before.uid !== 0 && before.uid !== currentUid)
      ) {
        throw new Error('runtime module trust check failed');
      }
      const loaded = await ports.importModule(pathToFileURL(`/proc/self/fd/${handle.fd}`).href);
      const after = await handle.stat();
      const named = await ports.lstat(path);
      if (
        !sameIdentity(before, after) ||
        after.dev !== named.dev || after.ino !== named.ino ||
        (await ports.realpath(path)) !== path
      ) {
        throw new Error('runtime module changed while it was loaded');
      }
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
        throw new Error('runtime module has an invalid namespace');
      }
      return loaded as Record<string, unknown>;
    } catch (error) {
      throw new Error('runtime module could not be opened safely', { cause: error });
    } finally {
      await handle?.close();
    }
  };
}

export const loadTrustedRuntimeModule = createTrustedRuntimeModuleLoader(PRODUCTION_PORTS);

export function requireModuleFactory<T>(
  module: Record<string, unknown>,
  exportName: string,
): (input: T) => Promise<unknown> | unknown {
  const factory = module[exportName];
  if (typeof factory !== 'function') {
    throw new Error(`runtime module does not export ${exportName}`);
  }
  return factory as (input: T) => Promise<unknown> | unknown;
}
