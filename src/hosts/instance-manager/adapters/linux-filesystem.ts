import { constants, type Stats } from 'node:fs';
import {
  lstat as nodeLstat,
  mkdir,
  open,
  realpath as nodeRealpath,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { posix } from 'node:path';

import type {
  DirectoryEntry,
  ExactTreeEntry,
  ExactTreeSnapshot,
  FileIdentity,
  FileSystemPort,
} from '../types';
import { sameFileSnapshot, sameIdentity } from '../validation';
import { LinuxHostAdapterError } from './errors';

export interface LinuxFileSystemOptions {
  readonly platform?: NodeJS.Platform;
  readonly procFdRoot?: string;
  /** Test-only fallback for kernels without a traversable /proc/self/fd. */
  readonly testOnlyDirectPaths?: boolean;
}

interface OpenedDirectory {
  readonly handle: FileHandle;
  readonly path: string;
}

function assertPath(path: string): string[] {
  if (
    !path || path.includes('\0') || !posix.isAbsolute(path) ||
    posix.normalize(path) !== path || Buffer.byteLength(path) > 4_096
  ) {
    throw new LinuxHostAdapterError('filesystem_failed', 'Filesystem path was rejected');
  }
  return path.split('/').filter(Boolean);
}

function assertBound(value: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new LinuxHostAdapterError('filesystem_failed', `${field} was rejected`);
  }
}

function identity(stat: Stats): FileIdentity {
  const kind: FileIdentity['kind'] = stat.isDirectory()
    ? 'directory'
    : stat.isFile()
      ? 'file'
      : stat.isSymbolicLink()
        ? 'symlink'
        : 'other';
  return {
    device: stat.dev,
    inode: stat.ino,
    kind,
    mode: stat.mode,
    uid: stat.uid,
    size: stat.size,
    modifiedAtMs: stat.mtimeMs,
  };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT');
}

function wrap(message: string, error: unknown): LinuxHostAdapterError {
  if (error instanceof LinuxHostAdapterError) return error;
  return new LinuxHostAdapterError('filesystem_failed', message);
}

function compareTrees(left: ExactTreeSnapshot, right: ExactTreeSnapshot): boolean {
  if (
    left.rootPath !== right.rootPath ||
    !sameFileSnapshot(left.rootIdentity, right.rootIdentity) ||
    left.entries.length !== right.entries.length
  ) return false;
  return left.entries.every((entry, index) => {
    const observed = right.entries[index];
    return observed.relativePath === entry.relativePath &&
      sameFileSnapshot(observed.identity, entry.identity);
  });
}

/** Linux host filesystem port. Every mutating leaf is reached from an O_NOFOLLOW directory fd. */
export class LinuxDescriptorFileSystem implements FileSystemPort {
  private readonly procFdRoot: string;
  private readonly directPaths: boolean;

  constructor(options: LinuxFileSystemOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.directPaths = options.testOnlyDirectPaths === true;
    if (platform !== 'linux' && !this.directPaths) {
      throw new LinuxHostAdapterError('platform_unsupported', 'Descriptor filesystem requires Linux');
    }
    this.procFdRoot = options.procFdRoot ?? '/proc/self/fd';
  }

  private descriptor(directory: OpenedDirectory, child?: string): string {
    if (child !== undefined && (!child || child.includes('/') || child.includes('\0'))) {
      throw new LinuxHostAdapterError('filesystem_failed', 'Filesystem child name was rejected');
    }
    const root = this.directPaths
      ? directory.path
      : `${this.procFdRoot}/${directory.handle.fd}`;
    return child === undefined ? root : posix.join(root, child);
  }

  private async openDirectory(path: string): Promise<OpenedDirectory> {
    const segments = assertPath(path);
    let current: OpenedDirectory = {
      handle: await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
      path: '/',
    };
    try {
      for (const segment of segments) {
        const nextPath = posix.join(current.path, segment);
        const next = await open(
          this.descriptor(current, segment),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        await current.handle.close();
        current = { handle: next, path: nextPath };
      }
      return current;
    } catch (error) {
      await current.handle.close();
      throw wrap('Directory traversal was rejected', error);
    }
  }

  private async withParent<T>(path: string, operation: (
    parent: OpenedDirectory,
    child: string,
  ) => Promise<T>): Promise<T> {
    const segments = assertPath(path);
    if (segments.length === 0) {
      throw new LinuxHostAdapterError('filesystem_failed', 'Filesystem root is not a leaf');
    }
    const child = segments.pop() as string;
    const parent = await this.openDirectory(`/${segments.join('/')}`);
    try {
      return await operation(parent, child);
    } finally {
      await parent.handle.close();
    }
  }

  private async lstatFrom(parent: OpenedDirectory, child: string): Promise<FileIdentity | null> {
    try {
      return identity(await nodeLstat(this.descriptor(parent, child)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw wrap('Filesystem identity inspection failed', error);
    }
  }

  async realpath(path: string): Promise<string> {
    const segments = assertPath(path);
    if (segments.length === 0) return '/';
    return this.withParent(path, async (parent, child) => {
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          this.descriptor(parent, child),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        return await nodeRealpath(this.directPaths ? path : `${this.procFdRoot}/${handle.fd}`);
      } catch (error) {
        throw wrap('Canonical path resolution failed', error);
      } finally {
        await handle?.close();
      }
    });
  }

  async lstat(path: string): Promise<FileIdentity | null> {
    const segments = assertPath(path);
    if (segments.length === 0) return identity(await nodeLstat('/'));
    return this.withParent(path, (parent, child) => this.lstatFrom(parent, child));
  }

  async readFile(path: string, maxBytes: number): Promise<Uint8Array> {
    assertBound(maxBytes, 16 * 1024 * 1024, 'File read bound');
    return this.withParent(path, async (parent, child) => {
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          this.descriptor(parent, child),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const before = identity(await handle.stat());
        if (before.kind !== 'file' || before.size > maxBytes) {
          throw new LinuxHostAdapterError('filesystem_failed', 'Bounded regular file read was rejected');
        }
        const bytes = await handle.readFile();
        const after = identity(await handle.stat());
        if (bytes.byteLength > maxBytes || !sameFileSnapshot(before, after)) {
          throw new LinuxHostAdapterError('identity_changed', 'File changed while it was read');
        }
        return new Uint8Array(bytes);
      } catch (error) {
        throw wrap('Bounded file read failed', error);
      } finally {
        await handle?.close();
      }
    });
  }

  async listDirectory(path: string, maxEntries: number): Promise<readonly DirectoryEntry[]> {
    assertBound(maxEntries, 100_000, 'Directory entry bound');
    const directory = await this.openDirectory(path);
    try {
      const before = identity(await directory.handle.stat());
      const names = await readdir(this.descriptor(directory));
      if (names.length > maxEntries) {
        throw new LinuxHostAdapterError('filesystem_failed', 'Directory entry bound was exceeded');
      }
      const entries: DirectoryEntry[] = [];
      for (const name of names.sort()) {
        const observed = await this.lstatFrom(directory, name);
        if (!observed) throw new LinuxHostAdapterError('identity_changed', 'Directory changed while listed');
        entries.push({ name, identity: observed });
      }
      if (!sameFileSnapshot(before, identity(await directory.handle.stat()))) {
        throw new LinuxHostAdapterError('identity_changed', 'Directory changed while listed');
      }
      return entries;
    } catch (error) {
      throw wrap('Directory listing failed', error);
    } finally {
      await directory.handle.close();
    }
  }

  async createDirectory(path: string, mode: number): Promise<FileIdentity> {
    return this.withParent(path, async (parent, child) => {
      try {
        await mkdir(this.descriptor(parent, child), { mode });
        const created = await open(
          this.descriptor(parent, child),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await created.chmod(mode);
          const observed = identity(await created.stat());
          if (observed.kind !== 'directory') throw new Error('not directory');
          return observed;
        } finally {
          await created.close();
        }
      } catch (error) {
        throw wrap('Exclusive directory creation failed', error);
      }
    });
  }

  async createFileExclusive(path: string, data: Uint8Array, mode: number): Promise<FileIdentity> {
    return this.withParent(path, async (parent, child) => {
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          this.descriptor(parent, child),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode,
        );
        await handle.chmod(mode);
        await handle.writeFile(data);
        await handle.sync();
        const observed = identity(await handle.stat());
        if (observed.kind !== 'file' || observed.size !== data.byteLength) throw new Error('write mismatch');
        return observed;
      } catch (error) {
        throw wrap('Exclusive file creation failed', error);
      } finally {
        await handle?.close();
      }
    });
  }

  async replaceFileAtomic(
    stagedPath: string,
    targetPath: string,
    expectedTarget: FileIdentity | null,
  ): Promise<FileIdentity> {
    if (posix.dirname(stagedPath) !== posix.dirname(targetPath)) {
      throw new LinuxHostAdapterError('filesystem_failed', 'Atomic replacement must stay in one directory');
    }
    return this.withParent(targetPath, async (parent, target) => {
      const staged = posix.basename(stagedPath);
      const stagedIdentity = await this.lstatFrom(parent, staged);
      const targetIdentity = await this.lstatFrom(parent, target);
      if (
        !stagedIdentity || stagedIdentity.kind !== 'file' ||
        (expectedTarget === null ? targetIdentity !== null :
          !targetIdentity || !sameIdentity(targetIdentity, expectedTarget))
      ) throw new LinuxHostAdapterError('identity_changed', 'Atomic replacement fence failed');
      try {
        await rename(this.descriptor(parent, staged), this.descriptor(parent, target));
        const observed = await this.lstatFrom(parent, target);
        if (!observed || !sameIdentity(observed, stagedIdentity)) throw new Error('replace mismatch');
        return observed;
      } catch (error) {
        throw wrap('Atomic file replacement failed', error);
      }
    });
  }

  async removeFileExact(path: string, expected: FileIdentity): Promise<void> {
    await this.withParent(path, async (parent, child) => {
      const observed = await this.lstatFrom(parent, child);
      if (!observed || observed.kind !== 'file' || !sameIdentity(observed, expected)) {
        throw new LinuxHostAdapterError('identity_changed', 'Exact file removal fence failed');
      }
      try { await unlink(this.descriptor(parent, child)); } catch (error) {
        throw wrap('Exact file removal failed', error);
      }
    });
  }

  async removeDirectoryExact(path: string, expected: FileIdentity): Promise<void> {
    await this.withParent(path, async (parent, child) => {
      const observed = await this.lstatFrom(parent, child);
      if (!observed || observed.kind !== 'directory' || !sameIdentity(observed, expected)) {
        throw new LinuxHostAdapterError('identity_changed', 'Exact directory removal fence failed');
      }
      try { await rmdir(this.descriptor(parent, child)); } catch (error) {
        throw wrap('Exact directory removal failed', error);
      }
    });
  }

  private async capture(directory: OpenedDirectory, maximum: number): Promise<ExactTreeEntry[]> {
    const output: ExactTreeEntry[] = [];
    const visit = async (current: OpenedDirectory, prefix: string): Promise<void> => {
      const names = (await readdir(this.descriptor(current))).sort();
      for (const name of names) {
        const observed = await this.lstatFrom(current, name);
        if (!observed || !['file', 'directory'].includes(observed.kind)) {
          throw new LinuxHostAdapterError('filesystem_failed', 'Exact tree contains an unsafe entry');
        }
        const relativePath = prefix ? `${prefix}/${name}` : name;
        output.push({ relativePath, identity: observed });
        if (output.length > maximum) {
          throw new LinuxHostAdapterError('filesystem_failed', 'Exact tree bound was exceeded');
        }
        if (observed.kind === 'directory') {
          const child = await open(
            this.descriptor(current, name),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await visit({ handle: child, path: posix.join(current.path, name) }, relativePath);
          } finally {
            await child.close();
          }
        }
      }
    };
    await visit(directory, '');
    return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async captureTreeExact(rootPath: string, maxEntries: number): Promise<ExactTreeSnapshot> {
    assertBound(maxEntries, 100_000, 'Tree entry bound');
    const root = await this.openDirectory(rootPath);
    try {
      const rootIdentity = identity(await root.handle.stat());
      const entries = await this.capture(root, maxEntries);
      if (!sameFileSnapshot(rootIdentity, identity(await root.handle.stat()))) {
        throw new LinuxHostAdapterError('identity_changed', 'Exact tree changed while captured');
      }
      if (entries.some((entry) => entry.identity.device !== rootIdentity.device)) {
        throw new LinuxHostAdapterError('filesystem_failed', 'Exact tree crossed a device boundary');
      }
      return { rootPath, rootIdentity, entries };
    } catch (error) {
      throw wrap('Exact tree capture failed', error);
    } finally {
      await root.handle.close();
    }
  }

  private async removeRelative(root: OpenedDirectory, entry: ExactTreeEntry): Promise<void> {
    const parts = entry.relativePath.split('/');
    let parent = root;
    const opened: OpenedDirectory[] = [];
    try {
      for (const segment of parts.slice(0, -1)) {
        const child = await open(
          this.descriptor(parent, segment),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        parent = { handle: child, path: posix.join(parent.path, segment) };
        opened.push(parent);
      }
      const name = parts.at(-1) as string;
      const observed = await this.lstatFrom(parent, name);
      if (!observed || !sameFileSnapshot(observed, entry.identity)) {
        throw new LinuxHostAdapterError('identity_changed', 'Exact tree entry changed before removal');
      }
      if (entry.identity.kind === 'file') await unlink(this.descriptor(parent, name));
      else await rmdir(this.descriptor(parent, name));
    } finally {
      for (const directory of opened.reverse()) await directory.handle.close();
    }
  }

  async removeTreeExact(snapshot: ExactTreeSnapshot): Promise<void> {
    const current = await this.captureTreeExact(snapshot.rootPath, snapshot.entries.length + 1);
    if (!compareTrees(snapshot, current)) {
      throw new LinuxHostAdapterError('identity_changed', 'Exact tree changed before removal');
    }
    const root = await this.openDirectory(snapshot.rootPath);
    try {
      if (!sameFileSnapshot(identity(await root.handle.stat()), snapshot.rootIdentity)) {
        throw new LinuxHostAdapterError('identity_changed', 'Exact tree root changed before removal');
      }
      const deepest = [...snapshot.entries].sort((left, right) => {
        const depth = right.relativePath.split('/').length - left.relativePath.split('/').length;
        return depth || right.relativePath.localeCompare(left.relativePath);
      });
      for (const entry of deepest) await this.removeRelative(root, entry);
    } catch (error) {
      throw wrap('Exact tree removal failed', error);
    } finally {
      await root.handle.close();
    }
    const observed = await this.lstat(snapshot.rootPath);
    if (!observed || !sameIdentity(observed, snapshot.rootIdentity)) {
      throw new LinuxHostAdapterError('identity_changed', 'Exact tree root changed before removal');
    }
    await this.removeDirectoryExact(snapshot.rootPath, observed);
  }
}
