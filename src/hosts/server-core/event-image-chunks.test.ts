import { describe, expect, it, vi } from 'vitest';
import { EventImageChunkReader } from './event-image-chunks';
import { SESSION_IMAGE_ASSET_CHUNK_BYTES as CHUNK, parseSessionImageAssetReadParams, parseSessionImageAssetReadResult } from '@contracts/session-image-assets';
import { projectSessionJson } from './session-event-projection';

const imageId = 'a'.repeat(64);
const signal = new AbortController().signal;
describe('event image Remote contract', () => {
  it('accepts opaque event-image handles and rejects mixed/cross-image sources', () => {
    expect(parseSessionImageAssetReadParams({ sessionId: 's', imageId, offset: 0 })).toMatchObject({ imageId });
    expect(() => parseSessionImageAssetReadParams({ sessionId: 's', imageId, changeId: 2, side: 'after', offset: 0 })).toThrow();
    expect(() => parseSessionImageAssetReadParams({ sessionId: 's', imageId: '../other', offset: 0 })).toThrow();
  });
  it('reads a stable snapshot across chunks and rechecks authorization', async () => {
    const bytes = Buffer.alloc(CHUNK + 3, 42);
    const authorized = vi.fn(() => true);
    const load = vi.fn(async () => ({ ok: true as const, bytes: bytes.length, mime: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }));
    const reader = new EventImageChunkReader({ authorized, load });
    const first = await reader.read({ sessionId: 's', imageId, offset: 0 }, signal, 1);
    expect(parseSessionImageAssetReadResult(first, { sessionId: 's', imageId })).toMatchObject({ bytes: CHUNK, nextOffset: CHUNK });
    if (!first.ok) throw new Error('missing chunk');
    const next = { sessionId: 's', imageId, offset: CHUNK, expectedAssetId: first.assetId };
    expect(await reader.read(next, signal, 2)).toMatchObject({ ok: true, bytes: 3, nextOffset: null });
    expect(load).toHaveBeenCalledOnce();
    expect(() => parseSessionImageAssetReadResult(first, { sessionId: 'other', imageId })).toThrow();
    authorized.mockReturnValue(false);
    expect(await reader.read(next, signal, 3)).toMatchObject({ ok: false, reason: 'denied' });
  });
  it('projects only public image metadata and keeps its hash intact', () => {
    const projected = projectSessionJson({ images: [{ id: imageId, name: 'image.png', mime: 'image/png', bytes: 3,
      source: { kind: 'path', path: '/private/root/image.png' } }] }, { workspaceRoot: '/workspace', privateRoots: ['/private/root'] });
    expect(projected).toEqual({ images: [{ id: imageId, name: 'image.png', mime: 'image/png', bytes: 3 }] });
  });
});
