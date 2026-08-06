import { constants } from 'node:fs';
import { open, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { requireAbsolutePath } from './validation';

type RuntimeStat = Awaited<ReturnType<FileHandle['stat']>>;

export interface TrustedRuntimeModulePorts {
  readonly platform: NodeJS.Platform;
  readonly currentUid: () => number | null;
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<RuntimeStat>;
  readonly archiveRealpath?: (path: string) => Promise<string>;
  readonly archiveLstat?: (path: string) => Promise<RuntimeStat>;
  readonly darwinDependencyUrl?: (applicationArchivePath: string) => string;
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
  readonly importModule: (url: string, darwinBetterSqliteUrl?: string) => Promise<unknown>;
}

const DARWIN_RUNTIME_SUFFIX =
  '/Contents/Resources/linux-headless/local-worker-runtime/index.mjs';

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
    if (ports.platform !== 'linux' && ports.platform !== 'darwin') {
      throw new Error('trusted runtime modules require Linux or macOS descriptor imports');
    }
    let handle: FileHandle | undefined;
    let darwinAsarPath: string | undefined;
    let darwinAsarBefore: RuntimeStat | undefined;
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
      const descriptorRoot = ports.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
      const descriptorUrl = pathToFileURL(`${descriptorRoot}/${handle.fd}`).href;
      let darwinBetterSqliteUrl: string | undefined;
      if (ports.platform === 'darwin') {
        if (!ports.darwinDependencyUrl) {
          throw new Error('macOS runtime dependency resolver is unavailable');
        }
        if (!path.endsWith(DARWIN_RUNTIME_SUFFIX)) {
          throw new Error('macOS runtime module is outside the packaged Worker layout');
        }
        darwinAsarPath = resolve(dirname(path), '../../app.asar');
        const archiveRealpath = ports.archiveRealpath ?? ports.realpath;
        const archiveLstat = ports.archiveLstat ?? ports.lstat;
        if ((await archiveRealpath(darwinAsarPath)) !== darwinAsarPath) {
          throw new Error('macOS application archive path is not canonical');
        }
        darwinAsarBefore = await archiveLstat(darwinAsarPath);
        const archiveMode = Number(darwinAsarBefore.mode);
        if (
          !darwinAsarBefore.isFile() || (archiveMode & 0o022) !== 0 ||
          (currentUid !== null && darwinAsarBefore.uid !== 0 &&
            darwinAsarBefore.uid !== currentUid)
        ) {
          throw new Error('macOS application archive trust check failed');
        }
        darwinBetterSqliteUrl = ports.darwinDependencyUrl(darwinAsarPath);
      }
      const loaded = darwinBetterSqliteUrl
        ? await ports.importModule(descriptorUrl, darwinBetterSqliteUrl)
        : await ports.importModule(descriptorUrl);
      const after = await handle.stat();
      const named = await ports.lstat(path);
      if (
        !sameIdentity(before, after) ||
        after.dev !== named.dev || after.ino !== named.ino ||
        (await ports.realpath(path)) !== path
      ) {
        throw new Error('runtime module changed while it was loaded');
      }
      if (darwinAsarPath && darwinAsarBefore) {
        const archiveRealpath = ports.archiveRealpath ?? ports.realpath;
        const archiveLstat = ports.archiveLstat ?? ports.lstat;
        const darwinAsarAfter = await archiveLstat(darwinAsarPath);
        if (
          !sameIdentity(darwinAsarBefore, darwinAsarAfter) ||
          (await archiveRealpath(darwinAsarPath)) !== darwinAsarPath
        ) {
          throw new Error('macOS application archive changed while runtime loaded');
        }
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
