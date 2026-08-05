import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';

import { requireAbsolutePath, requirePositiveInteger } from './validation';

export interface PrivateJsonFileOptions {
  readonly maxBytes?: number;
  readonly allowedUids?: readonly number[];
}

function sameSnapshot(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.uid === right.uid
  );
}

/** Reads one bounded regular file through O_NOFOLLOW and rejects writable/unowned config. */
export async function readPrivateJsonFile(
  path: string,
  options: PrivateJsonFileOptions = {},
): Promise<unknown> {
  requireAbsolutePath(path, 'config path');
  const maxBytes = requirePositiveInteger(options.maxBytes ?? 1024 * 1024, 'maxBytes');
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const allowedUids = options.allowedUids ?? (currentUid === null ? [] : [0, currentUid]);
  let handle;
  try {
    if ((await realpath(path)) !== path) throw new Error('config path is not canonical');
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > maxBytes ||
      (before.mode & 0o022) !== 0 ||
      (allowedUids.length > 0 && !allowedUids.includes(before.uid))
    ) {
      throw new Error('config file trust check failed');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size || !sameSnapshot(before, after) ||
      (await realpath(path)) !== path
    ) {
      throw new Error('config file changed while it was read');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('headless config could not be read safely', { cause: error });
  } finally {
    await handle?.close();
  }
}
