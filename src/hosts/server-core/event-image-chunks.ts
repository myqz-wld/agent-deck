import { createHash } from 'node:crypto';
import { SESSION_IMAGE_ASSET_CHUNK_BYTES, SESSION_IMAGE_ASSET_MAX_BYTES,
  type SessionImageAssetReadParams, type SessionImageAssetReadResult } from '@contracts/index';
import type { LoadImageBlobResult } from '@shared/types';

type ChunkResult = SessionImageAssetReadResult;
type ImageMime = Extract<ChunkResult, { ok: true }>['mime'];
type Snapshot = { buffer: Buffer; mime: ImageMime; assetId: string; createdAt: number };

/** A bounded immutable snapshot avoids rereading a whole image for every 512 KiB chunk. */
export class EventImageChunkReader {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(private readonly port: {
    authorized(sessionId: string, imageId: string): boolean;
    load(sessionId: string, imageId: string): Promise<LoadImageBlobResult>;
  }) {}

  async read(params: SessionImageAssetReadParams, signal: AbortSignal, revision: number): Promise<ChunkResult> {
    if (!('imageId' in params)) return { ok: false, reason: 'unsupported_source', revision };
    if (signal.aborted) return { ok: false, reason: 'io_error', revision };
    if (!this.port.authorized(params.sessionId, params.imageId)) return { ok: false, reason: 'denied', revision };
    const key = `${params.sessionId}:${params.imageId}`;
    for (const [id, entry] of this.snapshots) {
      if (Date.now() - entry.createdAt > 120_000) this.snapshots.delete(id);
    }
    let snapshot = this.snapshots.get(key);
    if (params.offset === 0) {
      const result = await this.port.load(params.sessionId, params.imageId);
      if (!result.ok) return { ok: false, reason: result.reason, revision };
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(result.mime)) {
        return { ok: false, reason: 'invalid_ext', revision };
      }
      if (result.bytes > SESSION_IMAGE_ASSET_MAX_BYTES) return { ok: false, reason: 'too_big', revision };
      const buffer = Buffer.from(result.dataUrl.slice(result.dataUrl.indexOf(',') + 1), 'base64');
      snapshot = { buffer, mime: result.mime as ImageMime, assetId: createHash('sha256').update(buffer).digest('base64url'), createdAt: Date.now() };
      this.snapshots.delete(key);
      let retained = [...this.snapshots.values()].reduce((sum, entry) => sum + entry.buffer.length, 0);
      while (this.snapshots.size && (retained + buffer.length > 32 * 1024 * 1024 || this.snapshots.size >= 8)) {
        const oldest = this.snapshots.keys().next().value!;
        retained -= this.snapshots.get(oldest)!.buffer.length;
        this.snapshots.delete(oldest);
      }
      this.snapshots.set(key, snapshot);
    }
    if (!snapshot || (params.expectedAssetId && snapshot.assetId !== params.expectedAssetId) ||
        params.offset >= snapshot.buffer.length) return { ok: false, reason: 'changed', revision };
    if (signal.aborted || !this.port.authorized(params.sessionId, params.imageId)) {
      return { ok: false, reason: 'denied', revision };
    }
    const chunk = snapshot.buffer.subarray(params.offset, params.offset + SESSION_IMAGE_ASSET_CHUNK_BYTES);
    return { ok: true, sessionId: params.sessionId, imageId: params.imageId, revision,
      assetId: snapshot.assetId, mime: snapshot.mime, base64: chunk.toString('base64'),
      bytes: chunk.length, totalBytes: snapshot.buffer.length, offset: params.offset,
      nextOffset: params.offset + chunk.length === snapshot.buffer.length ? null : params.offset + chunk.length };
  }
}
