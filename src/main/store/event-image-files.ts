import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeFileSync } from 'node:fs';
import { open, realpath, stat as pathStat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EVENT_IMAGE_ID, EVENT_IMAGE_MAX_BYTES, type EventImageRef } from '@shared/event-images';
import type { LoadImageBlobResult } from '@shared/types';
import { getApplicationHostPaths } from '@main/runtime-host/application-paths';

export interface StoredEventImage extends EventImageRef {
  source: { kind: 'stored' } | { kind: 'path'; path: string };
}
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
};
export function eventImageDirectory(): string {
  return join(getApplicationHostPaths().userDataPath, 'event-images');
}
function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function imageMime(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export function decodeEventImage(data: string, mime?: string): { buffer: Buffer; mime: string } {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/.exec(data);
  const base64 = match ? match[2] : data;
  const declared = match?.[1] ?? mime;
  // Avoid repeated capture groups: multi-megabyte images can exhaust V8's regexp stack.
  if (base64.length > Math.ceil(EVENT_IMAGE_MAX_BYTES / 3) * 4 || base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('图片数据无效或超出 16 MB 限制');
  }
  const buffer = Buffer.from(base64, 'base64');
  const detected = imageMime(buffer);
  if (!detected || buffer.length > EVENT_IMAGE_MAX_BYTES || (declared && declared !== detected)) {
    throw new Error('图片格式不受支持或数据不完整');
  }
  return { buffer, mime: detected };
}
export function persistInlineEventImage(data: string, mime?: string): StoredEventImage {
  const decoded = decodeEventImage(data, mime);
  const id = createHash('sha256').update(decoded.buffer).digest('hex');
  const directory = eventImageDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('图片存储目录不可用');
  const path = join(realpathSync(directory), id);
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, decoded.buffer); } finally { closeSync(fd); }
  } else {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const existing = fstatSync(fd);
      if (!existing.isFile() || existing.size !== decoded.buffer.length ||
          createHash('sha256').update(readFileSync(fd)).digest('hex') !== id) {
        throw new Error('图片存储内容已改变');
      }
    } finally { closeSync(fd); }
  }
  return { id, mime: decoded.mime, bytes: decoded.buffer.length,
    name: `image-${id.slice(0, 8)}${EXTENSIONS[decoded.mime]}`, source: { kind: 'stored' } };
}
export function referenceEventImagePath(path: string, cwd: string): StoredEventImage {
  if (path.length > 4096 || /[\u0000-\u001f]/.test(path)) throw new Error('图片路径无效');
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const ext = extname(absolute).toLowerCase();
  const mime = Object.entries(EXTENSIONS).find(([, candidate]) => candidate === ext)?.[0]
    ?? (ext === '.jpeg' ? 'image/jpeg' : '');
  if (!mime || absolute.includes('\0')) throw new Error('图片路径或格式不受支持');
  return { id: createHash('sha256').update(`path:${absolute}`).digest('hex'), mime,
    name: basename(absolute), source: { kind: 'path', path: absolute } };
}

/** The caller must resolve this descriptor from an event in the requested session. */
export async function loadStoredEventImage(
  image: StoredEventImage, workspaceRoot?: string, pathAllowed?: (path: string) => boolean,
): Promise<LoadImageBlobResult> {
  if (!EVENT_IMAGE_ID.test(image.id)) return { ok: false, reason: 'denied' };
  try {
    const source = image.source;
    if (source.kind === 'path' && !isAbsolute(source.path)) return { ok: false, reason: 'denied' };
    const directory = source.kind === 'stored' ? await realpath(eventImageDirectory())
      : workspaceRoot ? await realpath(workspaceRoot) : null;
    const requested = source.kind === 'stored' ? join(directory!, image.id) : source.path;
    const canonical = await realpath(requested);
    if (directory && !inside(directory, canonical)) return { ok: false, reason: 'denied' };
    if (source.kind === 'path' && pathAllowed && !pathAllowed(canonical)) return { ok: false, reason: 'denied' };
    const fh = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fh.stat();
      const current = await pathStat(canonical);
      if (!stat.isFile() || current.dev !== stat.dev || current.ino !== stat.ino ||
          await realpath(requested) !== canonical ||
          (directory && await realpath(source.kind === 'stored' ? eventImageDirectory() : workspaceRoot!) !== directory)) {
        return { ok: false, reason: 'denied' };
      }
      if (stat.size < 1 || stat.size > EVENT_IMAGE_MAX_BYTES) return { ok: false, reason: 'too_big' };
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await fh.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) return { ok: false, reason: 'changed' };
        offset += read.bytesRead;
      }
      const after = await fh.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return { ok: false, reason: 'changed' };
      const mime = imageMime(buffer);
      if (!mime || mime !== image.mime) return { ok: false, reason: 'invalid_ext' };
      if (source.kind === 'stored' && createHash('sha256').update(buffer).digest('hex') !== image.id) {
        return { ok: false, reason: 'changed' };
      }
      return { ok: true, mime, bytes: buffer.length, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
    } finally { await fh.close(); }
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'enoent' : 'io_error' };
  }
}
