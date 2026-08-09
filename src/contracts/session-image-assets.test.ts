import { describe, expect, it } from 'vitest';

import {
  SESSION_IMAGE_ASSET_CHUNK_BYTES,
  parseSessionImageAssetReadParams,
  parseSessionImageAssetReadResult,
} from './session-image-assets';

const assetId = 'A'.repeat(43);

describe('session image asset contracts', () => {
  it('requires a stable asset identity after the first aligned chunk', () => {
    expect(parseSessionImageAssetReadParams({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    })).toEqual({ sessionId: 'session-a', changeId: 3, side: 'after', offset: 0 });
    expect(parseSessionImageAssetReadParams({
      sessionId: 'session-a', changeId: 3, side: 'after',
      offset: SESSION_IMAGE_ASSET_CHUNK_BYTES, expectedAssetId: assetId,
    })).toMatchObject({ expectedAssetId: assetId });
    expect(() => parseSessionImageAssetReadParams({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 1,
    })).toThrow();
    expect(() => parseSessionImageAssetReadParams({
      sessionId: 'session-a', changeId: 3, side: 'after',
      offset: SESSION_IMAGE_ASSET_CHUNK_BYTES,
    })).toThrow();
  });

  it('validates canonical bounded chunks and terminal failures', () => {
    expect(parseSessionImageAssetReadResult({
      ok: true,
      assetId,
      base64: Buffer.from('image').toString('base64'),
      bytes: 5,
      changeId: 3,
      mime: 'image/png',
      nextOffset: null,
      offset: 0,
      revision: 4,
      sessionId: 'session-a',
      side: 'after',
      totalBytes: 5,
    }, { sessionId: 'session-a', changeId: 3, side: 'after' }))
      .toMatchObject({ ok: true, bytes: 5, totalBytes: 5 });
    expect(parseSessionImageAssetReadResult({
      ok: false, reason: 'too_big', revision: 4,
    })).toEqual({ ok: false, reason: 'too_big', revision: 4 });
    expect(() => parseSessionImageAssetReadResult({
      ok: true,
      assetId,
      base64: Buffer.from('image').toString('base64'),
      bytes: 4,
      changeId: 3,
      mime: 'image/png',
      nextOffset: null,
      offset: 0,
      revision: 4,
      sessionId: 'session-a',
      side: 'after',
      totalBytes: 5,
    })).toThrow();
    expect(() => parseSessionImageAssetReadResult({
      ok: true, assetId, base64: Buffer.from('image').toString('base64'), bytes: 5,
      changeId: 4, mime: 'image/png', nextOffset: null, offset: 0, revision: 4,
      sessionId: 'session-a', side: 'after', totalBytes: 5,
    }, { sessionId: 'session-a', changeId: 3, side: 'after' })).toThrow();
  });
});
