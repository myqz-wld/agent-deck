import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  SESSION_IMAGE_ASSET_CHUNK_BYTES,
  SESSION_IMAGE_ASSET_MAX_BYTES,
  type SessionImageAssetFailureReason,
  type SessionImageAssetReadParams,
} from '@contracts/index';
import type { FileChangePayload } from '@shared/types';

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
  ) {
    this.workspaceRootPath = resolve(workspaceRoot);
  }

  publicHandle(change: FileChangePayload, side: 'before' | 'after'): string | null {
    return storedSource(change, side)
      ? JSON.stringify({ kind: 'remote-file-change', changeId: change.id, side })
      : null;
  }

  async read(params: SessionImageAssetReadParams, signal: AbortSignal): Promise<AssetReadPayload> {
    if (signal.aborted) return { ok: false, reason: 'io_error' };
    const change = this.fileChanges.getPayload(params.sessionId, params.changeId);
    if (!change || change.kind !== 'image') return { ok: false, reason: 'unsupported_source' };
    const source = storedSource(change, params.side);
    if (!source) return { ok: false, reason: 'unsupported_source' };
    const requested = resolve(source.path);
    if (!inside(this.workspaceRootPath, requested)) return { ok: false, reason: 'denied' };

    let canonicalRoot: string;
    let canonical: string;
    try {
      canonicalRoot = await realpath(this.workspaceRootPath);
      canonical = await realpath(requested);
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'enoent' : 'io_error',
      };
    }
    if (!inside(canonicalRoot, canonical)) return { ok: false, reason: 'denied' };
    const mime = MIME_BY_EXT[extname(canonical).toLowerCase() as keyof typeof MIME_BY_EXT];
    if (!mime) return { ok: false, reason: 'invalid_ext' };

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'enoent' : 'io_error',
      };
    }
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) return { ok: false, reason: 'io_error' };
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
}
