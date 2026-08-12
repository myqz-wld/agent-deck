import { createHash } from 'node:crypto';
import { constants, realpathSync, type BigIntStats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  SESSION_IMAGE_ASSET_CHUNK_BYTES,
  SESSION_IMAGE_ASSET_MAX_BYTES,
  type SessionImageAssetFailureReason,
  type SessionImageAssetReadParams,
} from '@contracts/index';
import type { FileChangePayload, FileChangeSummary } from '@shared/types';
import { fileChangePathAuthorityFromMetadata } from '@shared/file-change-path-authority';
import { isRemoteSensitiveWorkspacePath } from './remote-sensitive-data';

const MIME_BY_EXT = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
} as const);

type ImageMime = (typeof MIME_BY_EXT)[keyof typeof MIME_BY_EXT];

type AssetReadPayload =
  | { ok: false; reason: SessionImageAssetFailureReason }
  | {
      ok: true;
      assetId: string;
      base64: string;
      bytes: number;
      changeId: number;
      mime: ImageMime;
      nextOffset: number | null;
      offset: number;
      sessionId: string;
      side: 'before' | 'after';
      totalBytes: number;
    };

interface StoredPathSource {
  kind: 'path';
  path: string;
}

export interface SessionImageAssetFilesystem {
  open(path: string, flags: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<BigIntStats>;
}

const filesystem: SessionImageAssetFilesystem = {
  open,
  realpath,
  stat: (path) => stat(path, { bigint: true }),
};

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function storedSource(change: FileChangePayload, side: 'before' | 'after'): StoredPathSource | null {
  const value = side === 'before'
    ? (change.beforeSnapshot ?? change.beforeBlob)
    : (change.afterSnapshot ?? change.afterBlob);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    if (
      Object.keys(raw).sort().join(',') !== 'kind,path' ||
      raw.kind !== 'path' ||
      typeof raw.path !== 'string' ||
      !isAbsolute(raw.path)
    ) return null;
    return { kind: 'path', path: raw.path };
  } catch {
    return null;
  }
}

export function fileChangePayloadMatchesDescriptor(
  descriptor: FileChangeSummary,
  change: FileChangePayload,
): boolean {
  const authorityMatches = descriptor.pathAuthority === undefined ||
    descriptor.pathAuthority === fileChangePathAuthorityFromMetadata(change.metadata);
  return authorityMatches && descriptor.id === change.id && descriptor.sessionId === change.sessionId &&
    descriptor.filePath === change.filePath && descriptor.kind === change.kind &&
    descriptor.toolCallId === change.toolCallId && descriptor.ts === change.ts &&
    descriptor.hasBeforeBlob === (change.beforeBlob !== null) &&
    descriptor.hasAfterBlob === (change.afterBlob !== null) &&
    descriptor.hasBeforeSnapshot === (change.beforeSnapshot != null) &&
    descriptor.hasAfterSnapshot === (change.afterSnapshot != null);
}

function identity(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return createHash('sha256')
    .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
    .digest('base64url');
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Buffer | null> {
  const output = Buffer.allocUnsafe(length);
  let cursor = 0;
  while (cursor < length) {
    const { bytesRead } = await handle.read(output, cursor, length - cursor, offset + cursor);
    if (bytesRead === 0) return null;
    cursor += bytesRead;
  }
  return output;
}

/** Reads only an image path already bound to an authoritative session file-change row. */
export class ServerCoreSessionImageAssetReader {
  private readonly workspaceRootPath: string;

  constructor(
    workspaceRoot: string,
    private readonly fileChanges: { getPayload(sessionId: string, id: number): FileChangePayload | null },
    private readonly canonicalizePath: (path: string) => string = realpathSync,
    private readonly fs: SessionImageAssetFilesystem = filesystem,
  ) {
    this.workspaceRootPath = resolve(workspaceRoot);
  }

  publicHandle(
    descriptor: FileChangeSummary,
    change: FileChangePayload,
    side: 'before' | 'after',
  ): string | null {
    if (!fileChangePayloadMatchesDescriptor(descriptor, change)) return null;
    if (!this.authorizedPathSync(descriptor.filePath)) return null;
    const source = storedSource(change, side);
    return source && this.authorizedPathSync(source.path)
      ? JSON.stringify({ kind: 'remote-file-change', changeId: change.id, side })
      : null;
  }

  async read(
    params: SessionImageAssetReadParams,
    signal: AbortSignal,
    descriptor: FileChangeSummary,
  ): Promise<AssetReadPayload> {
    if (signal.aborted) return { ok: false, reason: 'io_error' };
    if (
      descriptor.id !== params.changeId || descriptor.sessionId !== params.sessionId ||
      descriptor.kind !== 'image'
    ) return { ok: false, reason: 'unsupported_source' };
    const descriptorPath = await this.authorizedPath(descriptor.filePath);
    if (!descriptorPath.ok) return descriptorPath;
    const change = this.fileChanges.getPayload(params.sessionId, params.changeId);
    if (!change || !fileChangePayloadMatchesDescriptor(descriptor, change)) {
      return { ok: false, reason: 'unsupported_source' };
    }
    const source = storedSource(change, params.side);
    if (!source) return { ok: false, reason: 'unsupported_source' };
    const authorizedSource = await this.authorizedPath(source.path);
    if (!authorizedSource.ok) return authorizedSource;
    const canonical = authorizedSource.path;
    const mime = MIME_BY_EXT[extname(canonical).toLowerCase() as keyof typeof MIME_BY_EXT];
    if (!mime) return { ok: false, reason: 'invalid_ext' };

    let handle: FileHandle;
    try {
      handle = await this.fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'enoent' : 'io_error',
      };
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) return { ok: false, reason: 'io_error' };
      if (!await this.openedPathStillAuthorized(
        canonical,
        authorizedSource.root,
        stat,
      )) return { ok: false, reason: 'denied' };
      if (stat.size < 1n) return { ok: false, reason: 'io_error' };
      if (stat.size > BigInt(SESSION_IMAGE_ASSET_MAX_BYTES)) {
        return { ok: false, reason: 'too_big' };
      }
      const totalBytes = Number(stat.size);
      const assetId = identity(stat);
      if (params.expectedAssetId && params.expectedAssetId !== assetId) {
        return { ok: false, reason: 'changed' };
      }
      if (params.offset >= totalBytes || signal.aborted) {
        return { ok: false, reason: params.offset >= totalBytes ? 'changed' : 'io_error' };
      }
      const length = Math.min(SESSION_IMAGE_ASSET_CHUNK_BYTES, totalBytes - params.offset);
      const chunk = await readExactly(handle, params.offset, length);
      if (!chunk || signal.aborted) return { ok: false, reason: 'changed' };
      const nextOffset = params.offset + chunk.byteLength === totalBytes
        ? null
        : params.offset + chunk.byteLength;
      return {
        ok: true,
        assetId,
        base64: chunk.toString('base64'),
        bytes: chunk.byteLength,
        changeId: params.changeId,
        mime,
        nextOffset,
        offset: params.offset,
        sessionId: params.sessionId,
        side: params.side,
        totalBytes,
      };
    } catch {
      return { ok: false, reason: 'io_error' };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private authorizedPathSync(value: string): boolean {
    const requested = resolve(value);
    if (!inside(this.workspaceRootPath, requested)) return false;
    const projected = relative(this.workspaceRootPath, requested).split(sep).join('/');
    if (!projected || isRemoteSensitiveWorkspacePath(projected)) return false;
    try {
      const canonicalRoot = this.canonicalizePath(this.workspaceRootPath);
      const canonical = this.canonicalizePath(requested);
      if (!inside(canonicalRoot, canonical)) return false;
      const canonicalProjected = relative(canonicalRoot, canonical).split(sep).join('/');
      return Boolean(canonicalProjected) &&
        !isRemoteSensitiveWorkspacePath(canonicalProjected);
    } catch {
      return false;
    }
  }

  private async authorizedPath(
    value: string,
  ): Promise<
    { ok: true; path: string; root: string } |
    { ok: false; reason: SessionImageAssetFailureReason }
  > {
    const requested = resolve(value);
    if (!inside(this.workspaceRootPath, requested)) return { ok: false, reason: 'denied' };
    const projected = relative(this.workspaceRootPath, requested).split(sep).join('/');
    if (!projected || isRemoteSensitiveWorkspacePath(projected)) {
      return { ok: false, reason: 'denied' };
    }
    try {
      const canonicalRoot = await this.fs.realpath(this.workspaceRootPath);
      const canonical = await this.fs.realpath(requested);
      if (!inside(canonicalRoot, canonical)) return { ok: false, reason: 'denied' };
      const canonicalProjected = relative(canonicalRoot, canonical).split(sep).join('/');
      return canonicalProjected && !isRemoteSensitiveWorkspacePath(canonicalProjected)
        ? { ok: true, path: canonical, root: canonicalRoot }
        : { ok: false, reason: 'denied' };
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'enoent' : 'io_error',
      };
    }
  }

  private async openedPathStillAuthorized(
    authorizedPath: string,
    authorizedRoot: string,
    opened: BigIntStats,
  ): Promise<boolean> {
    try {
      const currentRoot = await this.fs.realpath(this.workspaceRootPath);
      const currentPath = await this.fs.realpath(authorizedPath);
      if (currentRoot !== authorizedRoot || !inside(authorizedRoot, currentPath)) return false;
      const projected = relative(authorizedRoot, currentPath).split(sep).join('/');
      if (!projected || isRemoteSensitiveWorkspacePath(projected)) return false;
      const current = await this.fs.stat(currentPath);
      return opened.dev === current.dev && opened.ino === current.ino;
    } catch {
      return false;
    }
  }
}
