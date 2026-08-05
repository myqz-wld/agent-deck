import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { requireAbsolutePath, requirePositiveInteger } from './validation';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

interface StateIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}

function sameIdentity(left: StateIdentity, right: StateIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid;
}

/** Atomic mode-0600 state constrained to one owned, non-writable-by-others directory. */
export class AtomicPrivateStateFile {
  readonly maxBytes: number;

  constructor(readonly path: string, maxBytes = 4 * 1024 * 1024) {
    requireAbsolutePath(path, 'state file');
    this.maxBytes = requirePositiveInteger(maxBytes, 'maxBytes');
  }

  private async assertParent(): Promise<void> {
    const parent = dirname(this.path);
    const identity = await lstat(parent);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      (identity.mode & 0o022) !== 0 ||
      (uid !== null && identity.uid !== uid && identity.uid !== 0) ||
      (await realpath(parent)) !== parent
    ) {
      throw new Error('state directory trust check failed');
    }
  }

  async read(): Promise<Uint8Array | null> {
    await this.assertParent();
    let handle;
    try {
      handle = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await handle.stat();
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (
        !before.isFile() ||
        before.size > this.maxBytes ||
        (before.mode & 0o777) !== 0o600 ||
        (uid !== null && before.uid !== uid && before.uid !== 0)
      ) {
        throw new Error('state file trust check failed');
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        bytes.byteLength !== before.size ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error('state file changed while it was read');
      }
      return bytes;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxBytes) {
      throw new Error('state file exceeds its byte bound');
    }
    await this.assertParent();
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    let expectedTarget: StateIdentity | null = null;
    try {
      const target = await lstat(this.path);
      if (
        !target.isFile() || target.isSymbolicLink() ||
        (target.mode & 0o777) !== 0o600 ||
        (uid !== null && target.uid !== uid)
      ) {
        throw new Error('state file target is unsafe');
      }
      expectedTarget = target;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const staged = join(dirname(this.path), `.agent-deck-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        staged,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      const stagedIdentity = await handle.stat();
      await handle.close();
      handle = undefined;
      let currentTarget: StateIdentity | null = null;
      try { currentTarget = await lstat(this.path); } catch (error) {
        if (!missing(error)) throw error;
      }
      if (
        expectedTarget === null ? currentTarget !== null :
          currentTarget === null || !sameIdentity(expectedTarget, currentTarget)
      ) throw new Error('state file target changed before replacement');
      await rename(staged, this.path);
      const installed = await lstat(this.path);
      if (
        !installed.isFile() || !sameIdentity(stagedIdentity, installed) ||
        (installed.mode & 0o777) !== 0o600 ||
        (uid !== null && installed.uid !== uid)
      ) throw new Error('state file replacement identity mismatch');
      const parent = await open(
        dirname(this.path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      await handle?.close();
      try {
        await unlink(staged);
      } catch {}
      throw error;
    }
  }
}
