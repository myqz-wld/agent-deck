import { posix } from 'node:path';

import type {
  DirectoryEntry,
  ExactTreeSnapshot,
  FileIdentity,
  FileSystemPort,
} from './types';
import { sameFileSnapshot, sameIdentity } from './validation';

interface FakeNode {
  identity: FileIdentity;
  data?: Uint8Array;
  target?: string;
}

function ordered(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class FakeFileSystem implements FileSystemPort {
  private readonly nodes = new Map<string, FakeNode>();
  private nextInode = 1;
  modifiedAtOffsetMs = 0;
  failNextReplacePath: string | null = null;
  failRemoveFileAtPath: string | null = null;
  afterRemoveFile: ((path: string) => void) | null = null;
  beforeRemoveTree: ((snapshot: ExactTreeSnapshot) => void) | null = null;
  failRemoveTreeAtPath: string | null = null;
  nextDirectoryIdentityPatch: Partial<FileIdentity> | null = null;

  constructor(private readonly nowMs: () => number) {
    this.seedDirectory('/', 0o755, 0);
  }

  private modifiedAtMs(): number {
    return this.nowMs() + this.modifiedAtOffsetMs;
  }

  private identity(kind: FileIdentity['kind'], mode: number, uid: number, size = 0): FileIdentity {
    return { device: 1, inode: this.nextInode++, kind, mode, uid, size, modifiedAtMs: this.modifiedAtMs() };
  }

  seedDirectory(path: string, mode = 0o700, uid = 1001): FileIdentity {
    const identity = this.identity('directory', mode, uid);
    this.nodes.set(path, { identity });
    return identity;
  }

  seedDirectoryChain(path: string, mode = 0o700, uid = 1001): void {
    let current = '/';
    for (const segment of path.split('/').filter(Boolean)) {
      current = posix.join(current, segment);
      if (!this.nodes.has(current)) this.seedDirectory(current, mode, uid);
    }
  }

  seedTrustedLeaf(path: string, mode: number, uid: number): void {
    this.seedDirectoryChain(posix.dirname(path), 0o755, 0);
    if (!this.nodes.has(path)) this.seedDirectory(path, mode, uid);
  }

  seedFile(path: string, text: string, options: { mode?: number; uid?: number; modifiedAtMs?: number } = {}): FileIdentity {
    this.seedDirectoryChain(posix.dirname(path), 0o700, options.uid ?? 1001);
    const data = new TextEncoder().encode(text);
    const identity = { ...this.identity('file', options.mode ?? 0o600, options.uid ?? 1001, data.byteLength), modifiedAtMs: options.modifiedAtMs ?? this.modifiedAtMs() };
    this.nodes.set(path, { identity, data });
    return identity;
  }

  seedSymlink(path: string, target: string): FileIdentity {
    this.seedDirectoryChain(posix.dirname(path));
    const identity = this.identity('symlink', 0o777, 1001, target.length);
    this.nodes.set(path, { identity, target });
    return identity;
  }

  readText(path: string): string {
    const node = this.nodes.get(path);
    if (!node?.data) throw new Error(`missing file ${path}`);
    return new TextDecoder().decode(node.data);
  }

  exists(path: string): boolean { return this.nodes.has(path); }

  stateFingerprint(): string {
    return JSON.stringify([...this.nodes.entries()]
      .sort(([left], [right]) => ordered(left, right))
      .map(([path, node]) => [path, node.identity, node.data ? Buffer.from(node.data).toString('hex') : null, node.target ?? null]));
  }

  mutateFile(path: string, text: string): void {
    const node = this.nodes.get(path);
    if (!node || node.identity.kind !== 'file') throw new Error(`missing file ${path}`);
    const data = new TextEncoder().encode(text);
    node.data = data;
    node.identity = { ...node.identity, size: data.byteLength, modifiedAtMs: this.modifiedAtMs() };
  }

  mutateIdentity(path: string, patch: Partial<FileIdentity>): void {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`missing node ${path}`);
    node.identity = { ...node.identity, ...patch };
  }

  async realpath(path: string): Promise<string> {
    const parts = path.split('/').filter(Boolean);
    let current = '/';
    for (let index = 0; index < parts.length; index += 1) {
      current = posix.join(current, parts[index]);
      const node = this.nodes.get(current);
      if (!node) throw new Error(`ENOENT ${current}`);
      if (node.identity.kind === 'symlink') return posix.normalize(posix.join(node.target as string, parts.slice(index + 1).join('/')));
    }
    return current;
  }

  async lstat(path: string): Promise<FileIdentity | null> { return this.nodes.get(path)?.identity ?? null; }

  async readFile(path: string, maxBytes: number): Promise<Uint8Array> {
    const node = this.nodes.get(path);
    if (!node?.data || node.data.byteLength > maxBytes) throw new Error(`read rejected ${path}`);
    return new Uint8Array(node.data);
  }

  async listDirectory(path: string, maxEntries: number): Promise<readonly DirectoryEntry[]> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const entries: DirectoryEntry[] = [];
    for (const [candidate, node] of this.nodes) {
      if (!candidate.startsWith(prefix)) continue;
      const relative = candidate.slice(prefix.length);
      if (relative && !relative.includes('/')) entries.push({ name: relative, identity: node.identity });
    }
    if (entries.length > maxEntries) throw new Error('directory bound exceeded');
    return entries.sort((left, right) => ordered(left.name, right.name));
  }

  async createDirectory(path: string, mode: number): Promise<FileIdentity> {
    if (this.nodes.has(path) || !this.nodes.has(posix.dirname(path))) throw new Error(`mkdir ${path}`);
    const identity = { ...this.identity('directory', mode, 1001), ...this.nextDirectoryIdentityPatch };
    this.nextDirectoryIdentityPatch = null;
    this.nodes.set(path, { identity });
    return identity;
  }

  async createFileExclusive(path: string, data: Uint8Array, mode: number): Promise<FileIdentity> {
    if (this.nodes.has(path) || !this.nodes.has(posix.dirname(path))) throw new Error(`write ${path}`);
    const identity = this.identity('file', mode, 1001, data.byteLength);
    this.nodes.set(path, { identity, data: new Uint8Array(data) });
    return identity;
  }

  async replaceFileAtomic(stagedPath: string, targetPath: string, expectedTarget: FileIdentity | null): Promise<FileIdentity> {
    if (this.failNextReplacePath === targetPath) { this.failNextReplacePath = null; throw new Error(`replace failure ${targetPath}`); }
    const staged = this.nodes.get(stagedPath);
    const target = this.nodes.get(targetPath);
    if (!staged || staged.identity.kind !== 'file') throw new Error('missing staged file');
    if (expectedTarget === null ? target !== undefined : !target || !sameIdentity(target.identity, expectedTarget)) throw new Error('target identity conflict');
    this.nodes.delete(stagedPath);
    this.nodes.set(targetPath, staged);
    return staged.identity;
  }

  async removeFileExact(path: string, expected: FileIdentity): Promise<void> {
    if (this.failRemoveFileAtPath === path) {
      this.failRemoveFileAtPath = null;
      throw new Error(`interrupted file removal ${path}`);
    }
    const node = this.nodes.get(path);
    if (!node || node.identity.kind !== 'file' || !sameIdentity(node.identity, expected)) throw new Error(`unlink identity ${path}`);
    this.nodes.delete(path);
    const after = this.afterRemoveFile;
    this.afterRemoveFile = null;
    after?.(path);
  }

  async removeDirectoryExact(path: string, expected: FileIdentity): Promise<void> {
    const node = this.nodes.get(path);
    if (!node || node.identity.kind !== 'directory' || !sameIdentity(node.identity, expected)) throw new Error(`rmdir identity ${path}`);
    if ([...this.nodes.keys()].some((candidate) => candidate.startsWith(`${path}/`))) throw new Error(`rmdir nonempty ${path}`);
    this.nodes.delete(path);
  }

  async captureTreeExact(rootPath: string, maxEntries: number): Promise<ExactTreeSnapshot> {
    const root = this.nodes.get(rootPath);
    if (!root || root.identity.kind !== 'directory') throw new Error(`missing tree ${rootPath}`);
    const prefix = `${rootPath}/`;
    const entries = [...this.nodes.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix))
      .map(([candidate, node]) => ({ relativePath: candidate.slice(prefix.length), identity: { ...node.identity } }))
      .sort((left, right) => ordered(left.relativePath, right.relativePath));
    if (entries.length > maxEntries) throw new Error('tree bound exceeded');
    return { rootPath, rootIdentity: { ...root.identity }, entries };
  }

  async removeTreeExact(snapshot: ExactTreeSnapshot): Promise<void> {
    if (this.failRemoveTreeAtPath === snapshot.rootPath) {
      this.failRemoveTreeAtPath = null;
      throw new Error(`interrupted tree removal ${snapshot.rootPath}`);
    }
    this.beforeRemoveTree?.(snapshot);
    this.beforeRemoveTree = null;
    const current = await this.captureTreeExact(snapshot.rootPath, snapshot.entries.length + 1);
    if (!sameFileSnapshot(current.rootIdentity, snapshot.rootIdentity) || current.entries.length !== snapshot.entries.length) throw new Error('exact tree changed');
    for (const [index, expected] of snapshot.entries.entries()) {
      const observed = current.entries[index];
      if (observed.relativePath !== expected.relativePath || !sameFileSnapshot(observed.identity, expected.identity) || observed.identity.device !== snapshot.rootIdentity.device || !['file', 'directory'].includes(observed.identity.kind)) throw new Error('exact tree entry changed');
    }
    for (const candidate of [snapshot.rootPath, ...snapshot.entries.map((entry) => posix.join(snapshot.rootPath, entry.relativePath))].sort((a, b) => b.length - a.length)) this.nodes.delete(candidate);
  }
}
