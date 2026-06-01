/**
 * image-uploads 持久层回归测试（REVIEW_102 — 图片附件子系统 deep-review 补测）。
 *
 * 双 reviewer 都命中「整个上传子系统零单测覆盖」（codex INFO / claude MED-3）。本文件补 main
 * 侧最高价值、环境最稳的真测（纯 fs，不依赖 SQLite better-sqlite3 binding，不受 ABI 守门影响）：
 * - writeUploadedImage：mime 反查 ext / base64 解码实测对账 / 空图拒 / 单图上限 / base64 长度 cap
 * - loadUploadedImage：realpath 严格前缀（防穿越 / 相邻目录前缀混淆）/ ext 白名单 / size 上限
 * - deleteUploadIfExists：只删 uploads 目录内（防 `..` 穿越删任意盘）
 * - reapStaleUploads：mtime > cutoff 才清，新文件不误删
 *
 * 用 local vi.mock('@main/paths') 把 getImageUploadsDir 指向独立 mkdtemp 目录，避免全局
 * fakeBase 污染 + 每个 test 隔离。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

// 每个测试文件独立 uploads 目录（module 级，mock 闭包引用）
let uploadsDir = '';

vi.mock('@main/paths', () => ({
  getImageUploadsDir: () => uploadsDir,
}));

// mock logger 避免 electron-log 噪音（vitest-setup 已 mock electron-log/main，这里再兜一层 scope）
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  writeUploadedImage,
  loadUploadedImage,
  deleteUploadIfExists,
  reapStaleUploads,
} from '../image-uploads';
import { MAX_IMAGE_BYTES } from '@main/ipc/_image-constants';

/** 1x1 PNG 的纯 base64（无 dataUrl 前缀）。 */
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function b64Bytes(b64: string): number {
  return Buffer.from(b64, 'base64').length;
}

beforeEach(() => {
  uploadsDir = mkdtempSync(join(tmpdir(), 'img-uploads-test-'));
});

afterEach(() => {
  try {
    rmSync(uploadsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

describe('writeUploadedImage', () => {
  it('正常 png：mime 反查 .png ext + bytes 对账通过 + 落盘到 uploads 目录', async () => {
    const bytes = b64Bytes(PNG_1x1_B64);
    const ref = await writeUploadedImage({ kind: 'image', base64: PNG_1x1_B64, mime: 'image/png', bytes });
    expect(ref.kind).toBe('uploaded');
    expect(ref.mime).toBe('image/png');
    expect(ref.bytes).toBe(bytes);
    expect(ref.path.startsWith(uploadsDir + sep)).toBe(true);
    expect(ref.path.endsWith('.png')).toBe(true);
    expect(existsSync(ref.path)).toBe(true);
  });

  it('image/jpeg → 落盘 .jpg（PREFERRED_EXT_BY_MIME 固定）', async () => {
    // 用同一份 png bytes，仅声明 mime=jpeg（测 ext 反查，不验图像有效性）
    const bytes = b64Bytes(PNG_1x1_B64);
    const ref = await writeUploadedImage({ kind: 'image', base64: PNG_1x1_B64, mime: 'image/jpeg', bytes });
    expect(ref.path.endsWith('.jpg')).toBe(true);
  });

  it('非白名单 mime（svg）→ 拒绝（不接受 renderer 传 ext）', async () => {
    const bytes = b64Bytes(PNG_1x1_B64);
    await expect(
      writeUploadedImage({ kind: 'image', base64: PNG_1x1_B64, mime: 'image/svg+xml', bytes }),
    ).rejects.toThrow(/unsupported attachment mime/);
  });

  it('bytes 对账失败（reported ≠ actual）→ 拒绝（防 IPC 篡改）', async () => {
    const actual = b64Bytes(PNG_1x1_B64);
    await expect(
      writeUploadedImage({ kind: 'image', base64: PNG_1x1_B64, mime: 'image/png', bytes: actual + 1 }),
    ).rejects.toThrow(/bytes mismatch/);
  });

  it('空图（base64 解码 0 字节）→ 拒绝', async () => {
    await expect(
      writeUploadedImage({ kind: 'image', base64: '', mime: 'image/png', bytes: 0 }),
    ).rejects.toThrow(/empty/);
  });

  it('base64 长度超 cap（解码前预检）→ 拒绝，不分配完整 Buffer', async () => {
    // 构造一个 base64 长度 > ceil(MAX*4/3)+4 的串（内容无所谓，长度命中即拒）
    const overLen = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;
    const huge = 'A'.repeat(overLen);
    await expect(
      writeUploadedImage({ kind: 'image', base64: huge, mime: 'image/png', bytes: MAX_IMAGE_BYTES }),
    ).rejects.toThrow(/exceeds cap/);
  });

  it('invalid shape（base64 非 string）→ 拒绝', async () => {
    await expect(
      // @ts-expect-error 故意传错 shape
      writeUploadedImage({ kind: 'image', base64: 123, mime: 'image/png', bytes: 1 }),
    ).rejects.toThrow(/invalid attachment input shape/);
  });
});

describe('loadUploadedImage', () => {
  it('正常往返：write 后 load 回 dataUrl', async () => {
    const bytes = b64Bytes(PNG_1x1_B64);
    const ref = await writeUploadedImage({ kind: 'image', base64: PNG_1x1_B64, mime: 'image/png', bytes });
    const result = await loadUploadedImage(ref.path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mime).toBe('image/png');
      expect(result.bytes).toBe(bytes);
      expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    }
  });

  it('相对路径 → denied（必须绝对路径）', async () => {
    const result = await loadUploadedImage('relative/foo.png');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('denied');
  });

  it('uploads 目录外的绝对路径 → denied（前缀穿越防护）', async () => {
    // 在 uploads 同级建一个库外文件
    const outside = mkdtempSync(join(tmpdir(), 'img-outside-'));
    const evil = join(outside, 'evil.png');
    writeFileSync(evil, Buffer.from(PNG_1x1_B64, 'base64'));
    try {
      const result = await loadUploadedImage(evil);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('denied');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('不存在的文件 → enoent', async () => {
    const result = await loadUploadedImage(join(uploadsDir, 'nope.png'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('enoent');
  });

  it('uploads 内但非白名单 ext（.txt）→ invalid_ext', async () => {
    const txt = join(uploadsDir, 'note.txt');
    writeFileSync(txt, 'hello');
    const result = await loadUploadedImage(txt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_ext');
  });

  it('超 size 上限 → too_big', async () => {
    // 写一个超 MAX_IMAGE_BYTES 的 .png（内容随意，只测 stat.size 闸门）
    const big = join(uploadsDir, 'big.png');
    writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const result = await loadUploadedImage(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_big');
  });
});

describe('deleteUploadIfExists', () => {
  it('删 uploads 内文件', async () => {
    const bytes = b64Bytes(PNG_1x1_B64);
    const ref = await writeUploadedImage({ kind: 'image', base64: PNG_1x1_B64, mime: 'image/png', bytes });
    expect(existsSync(ref.path)).toBe(true);
    await deleteUploadIfExists(ref.path);
    expect(existsSync(ref.path)).toBe(false);
  });

  it('`..` 穿越路径 → 不删（库外文件安全）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'img-del-outside-'));
    const victim = join(outside, 'victim.png');
    writeFileSync(victim, 'important');
    try {
      // 构造一个经 uploads 目录 `..` 穿越到库外的路径
      const traversal = join(uploadsDir, '..', '..', victim.slice(1));
      await deleteUploadIfExists(traversal);
      expect(existsSync(victim)).toBe(true); // 没被删
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('空 / 非 string path → no-op 不抛', async () => {
    await expect(deleteUploadIfExists('')).resolves.toBeUndefined();
    // @ts-expect-error 故意传 null
    await expect(deleteUploadIfExists(null)).resolves.toBeUndefined();
  });
});

describe('reapStaleUploads', () => {
  it('清掉 mtime 超 cutoff 的旧文件，保留新文件', async () => {
    const oldFile = join(uploadsDir, 'old.png');
    const newFile = join(uploadsDir, 'new.png');
    writeFileSync(oldFile, Buffer.from(PNG_1x1_B64, 'base64'));
    writeFileSync(newFile, Buffer.from(PNG_1x1_B64, 'base64'));
    // 把 oldFile mtime 改成 100 天前
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, old, old);
    await reapStaleUploads(14 * 24 * 60 * 60 * 1000);
    expect(existsSync(oldFile)).toBe(false); // 超 14 天 → 清
    expect(existsSync(newFile)).toBe(true); // 新文件保留
  });

  it('目录不存在 → no-op 不抛', async () => {
    rmSync(uploadsDir, { recursive: true, force: true });
    await expect(reapStaleUploads()).resolves.toBeUndefined();
    // 重建给 afterEach 清理
    uploadsDir = mkdtempSync(join(tmpdir(), 'img-uploads-test-'));
  });

  it('全是新文件 → 一个都不清', async () => {
    writeFileSync(join(uploadsDir, 'a.png'), Buffer.from(PNG_1x1_B64, 'base64'));
    writeFileSync(join(uploadsDir, 'b.png'), Buffer.from(PNG_1x1_B64, 'base64'));
    await reapStaleUploads(14 * 24 * 60 * 60 * 1000);
    expect(readdirSync(uploadsDir).length).toBe(2);
  });
});
