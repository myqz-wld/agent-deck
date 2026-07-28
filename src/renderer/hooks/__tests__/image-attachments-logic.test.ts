/** Pure attachment cache, animation detection, and sidecar-bound regressions. */
import { describe, expect, it } from 'vitest';
import { evictToBudget, type CacheEntry } from '../useImageBlob';
import { isAnimatedWebpHeader, detectAnimatedWebp } from '../useImageAttachments';
import {
  imageAttachmentSidecarStats,
  resetImageAttachmentSidecarForTests,
  storeAttachmentPayload,
} from '../image-attachments/payload-sidecar';

function okEntry(bytes: number, ts: number): CacheEntry {
  return { result: { ok: true, mime: 'image/png', bytes, dataUrl: 'data:image/png;base64,x' }, ts };
}

describe('evictToBudget count and byte limits', () => {
  it('连续塞 60 张 27MB 大图 → 字节预算压到 ≤128MB（约 4 张）', () => {
    const cache = new Map<string, CacheEntry>();
    for (let i = 0; i < 60; i++) {
      cache.set(`img${i}`, okEntry(27 * 1024 * 1024, i));
      evictToBudget(cache, `img${i}`);
    }
    let total = 0;
    for (const v of cache.values()) total += v.result.ok ? v.result.bytes : 0;
    expect(total).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(cache.size).toBeLessThanOrEqual(50);
    // 最新的几张应保留（LRU 保新弃旧）
    expect(cache.has('img59')).toBe(true);
    expect(cache.has('img0')).toBe(false);
  });

  it('塞 60 张 1MB 小图 → 条数预算先触发（保留最新 50 条，字节远没到上限）', () => {
    const cache = new Map<string, CacheEntry>();
    for (let i = 0; i < 60; i++) {
      cache.set(`s${i}`, okEntry(1 * 1024 * 1024, i));
      evictToBudget(cache, `s${i}`);
    }
    expect(cache.size).toBe(50);
    expect(cache.has('s59')).toBe(true);
    expect(cache.has('s9')).toBe(false); // 最旧 10 条被逐
  });

  it('单张超大图（200MB）刚 set → newKey 保护，不自我驱逐', () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('normal', okEntry(5 * 1024 * 1024, 0));
    evictToBudget(cache, 'normal');
    cache.set('huge', okEntry(200 * 1024 * 1024, 1));
    evictToBudget(cache, 'huge');
    expect(cache.has('huge')).toBe(true); // 不被自己挤掉（否则永远 miss）
    expect(cache.has('normal')).toBe(false); // 旧的被清
  });

  it('LRU 顺序：最旧 ts 先被逐', () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('old', okEntry(50 * 1024 * 1024, 1));
    evictToBudget(cache, 'old');
    cache.set('mid', okEntry(50 * 1024 * 1024, 2));
    evictToBudget(cache, 'mid');
    cache.set('new', okEntry(50 * 1024 * 1024, 3)); // 150MB > 128MB → 逐最旧
    evictToBudget(cache, 'new');
    expect(cache.has('old')).toBe(false);
    expect(cache.has('mid')).toBe(true);
    expect(cache.has('new')).toBe(true);
  });

  it('空 cache / 单条不超预算 → 不驱逐', () => {
    const cache = new Map<string, CacheEntry>();
    cache.set('a', okEntry(10 * 1024 * 1024, 0));
    evictToBudget(cache, 'a');
    expect(cache.size).toBe(1);
  });
});

describe('isAnimatedWebpHeader', () => {
  function webpHeader({ vp8x, anim }: { vp8x: boolean; anim?: boolean }): Uint8Array {
    const b = new Uint8Array(32);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    if (vp8x) {
      b.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
      b[20] = anim ? 0x02 : 0x00; // ANIM flag bit
    } else {
      b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 " simple lossy (never animated)
    }
    return b;
  }

  it('VP8X + ANIM flag → animated', () => {
    expect(isAnimatedWebpHeader(webpHeader({ vp8x: true, anim: true }))).toBe(true);
  });

  it('VP8X 无 ANIM（静态扩展 webp，如带 alpha/icc）→ 非 animated', () => {
    expect(isAnimatedWebpHeader(webpHeader({ vp8x: true, anim: false }))).toBe(false);
  });

  it('VP8 simple lossy（永远静态）→ 非 animated', () => {
    expect(isAnimatedWebpHeader(webpHeader({ vp8x: false }))).toBe(false);
  });

  it('头太短（< 21 字节）→ false', () => {
    expect(isAnimatedWebpHeader(new Uint8Array(10))).toBe(false);
  });

  it('非 RIFF（如 PNG 头）→ false', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47], 0); // PNG magic
    expect(isAnimatedWebpHeader(png)).toBe(false);
  });

  it('RIFF 但非 WEBP（如 WAV）→ false', () => {
    const wav = new Uint8Array(32);
    wav.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(isAnimatedWebpHeader(wav)).toBe(false);
  });
});

describe('detectAnimatedWebp File integration', () => {
  function webpFile({ vp8x, anim, tailBytes = 0 }: { vp8x: boolean; anim?: boolean; tailBytes?: number }): File {
    const head = new Uint8Array(32 + tailBytes);
    head.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    head.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    if (vp8x) {
      head.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
      head[20] = anim ? 0x02 : 0x00;
    } else {
      head.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
    }
    return new File([head], 'x.webp', { type: 'image/webp' });
  }

  it('animated webp File → true（读前 32 字节 slice 检测 ANIM bit）', async () => {
    expect(await detectAnimatedWebp(webpFile({ vp8x: true, anim: true, tailBytes: 100 }))).toBe(true);
  });

  it('静态 VP8X webp File → false', async () => {
    expect(await detectAnimatedWebp(webpFile({ vp8x: true, anim: false, tailBytes: 100 }))).toBe(false);
  });

  it('simple lossy webp File → false', async () => {
    expect(await detectAnimatedWebp(webpFile({ vp8x: false, tailBytes: 100 }))).toBe(false);
  });

  it('非 webp 内容的 File → false（保守不拦截）', async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])], 'x.png', {
      type: 'image/png',
    });
    expect(await detectAnimatedWebp(png)).toBe(false);
  });
});

describe('full-payload sidecar bounds', () => {
  it('refuses admission after the bounded payload count without exposing payloads in state', () => {
    resetImageAttachmentSidecarForTests();
    for (let index = 0; index < 128; index += 1) {
      expect(storeAttachmentPayload('session', String(index), {
        base64: 'c2FmZQ==',
        mime: 'image/png',
        bytes: 4,
      })).toBe(true);
    }
    expect(storeAttachmentPayload('session', 'overflow', {
      base64: 'b3ZlcmZsb3c=',
      mime: 'image/png',
      bytes: 8,
    })).toBe(false);
    expect(imageAttachmentSidecarStats()).toMatchObject({
      payloads: 128,
      sessions: 1,
    });
    resetImageAttachmentSidecarForTests();
  });
});
