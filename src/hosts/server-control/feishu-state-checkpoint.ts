import { closeSync, constants, fchownSync, fstatSync, fsyncSync, lstatSync, mkdtempSync,
  openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireFeishuDirectory, type FeishuProvisioningPaths } from './feishu-provisioning';

type Owner = { uid: number; gid: number };
const MAX_METADATA_BYTES = 128 * 1024 * 1024;

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function quietDatabase(path: string): void {
  if (['-journal', '-wal', '-shm'].some(suffix => present(path + suffix))) {
    throw new Error('Feishu metadata has an unfinished SQLite journal; offline recovery is required');
  }
}

function readPrivate(path: string, owner: Owner): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== owner.uid || st.gid !== owner.gid ||
      (st.mode & 0o777) !== 0o600 || st.size > MAX_METADATA_BYTES) {
      throw new Error('Feishu metadata checkpoint trust check failed');
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function writePrivate(path: string, data: Buffer, owner: Owner): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchownSync(fd, owner.uid, owner.gid);
    writeFileSync(fd, data); fsyncSync(fd);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  } finally { closeSync(fd); }
}

export interface FeishuStateCheckpoint {
  restore(): void;
  discard(): void;
}

/** Call only while the verified service is stopped; preserve failed state before restoring. */
export function checkpointFeishuState(paths: FeishuProvisioningPaths, owner: Owner): FeishuStateCheckpoint {
  requireFeishuDirectory(paths.stateDirectory, owner, 0o700);
  const rootOwner = { uid: process.getuid!(), gid: process.getgid!() };
  requireFeishuDirectory(paths.runtimeRoot, rootOwner, 0o755);
  const path = join(paths.stateDirectory, 'metadata.sqlite3');
  quietDatabase(path);
  const original = present(path) ? readPrivate(path, owner) : null;
  const directory = mkdtempSync(join(paths.runtimeRoot, '.state-checkpoint-'));
  try {
    if (original) writePrivate(join(directory, 'before.sqlite3'), original, rootOwner);
    syncDirectory(directory);
    syncDirectory(paths.runtimeRoot);
  } catch (e) { rmSync(directory, { recursive: true }); throw e; }
  return {
    restore() {
      requireFeishuDirectory(paths.stateDirectory, owner, 0o700);
      quietDatabase(path);
      if (present(path)) writePrivate(join(directory, 'failed.sqlite3'), readPrivate(path, owner), rootOwner);
      syncDirectory(directory);
      if (original === null) { rmSync(path, { force: true }); syncDirectory(paths.stateDirectory); return; }
      const restored = readPrivate(join(directory, 'before.sqlite3'), rootOwner);
      const staging = join(paths.stateDirectory, '.metadata-restore-' + directory.split('-').at(-1));
      let created = false;
      try {
        writePrivate(staging, restored, owner);
        created = true;
        renameSync(staging, path);
        syncDirectory(paths.stateDirectory);
      } finally { if (created) rmSync(staging, { force: true }); }
    },
    discard() { rmSync(directory, { recursive: true }); },
  };
}
