/**
 * 用户从输入框上传的图片：写盘 / 加载 / reaper。
 *
 * 设计要点（与 ipc/images.ts 的 ImageLoadBlob 区分）：
 * - ImageLoadBlob 走 file_changes / tool-use-start 双白名单（防 renderer 越权读任意磁盘）
 *   user upload 不在 file_changes 里，硬塞会污染 file_changes 表语义
 * - 这里走完全独立白名单：路径必须在 `<userData>/image-uploads/` 下
 * - 落盘策略：扁平 `<userData>/image-uploads/<uuid>.<ext>`，不按 sessionId 分目录
 *   理由：NewSessionDialog 路径在 createSession **之前**就要落盘喂 SDK，那时 sessionId 还不存在；
 *         扁平结构避免「先写 _pending → 拿到 realId 再 mv」的复杂度，也避免 codex 已经把
 *         旧路径塞进 thread 后 mv 让它读不到
 *
 * 安全护栏（照搬 ipc/images.ts:66-117 五步）：
 * - 写盘：mime → 反查 ext（不接 renderer 传 ext，杜绝 `.png\x00.exe` 注入）+ bytes 实测对账 + size 上限
 * - 读盘：realpath → `real.startsWith(uploadsDir + sep)` 严格前缀 → ext + size + 单 fd open/stat/readFile（TOCTOU）
 *
 * 清理策略：
 * - bootstrap 启动时 reapStaleUploads（mtime > 14 天）兜底
 * - codex closeSession 时 fire-and-forget unlink 队列里残留的 path（reduce 孤儿）
 * - sendMessage / createSession throw 时回滚已写文件（成功路径不动，path 已塞进 SDK 队列）
 * - session delete 不主动清（events 表 CASCADE 删 payload，path 没人引用 → reaper 兜底）
 */
import { extname, sep, resolve } from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { LoadImageBlobResult, UploadedAttachmentInput, UploadedAttachmentRef } from '@shared/types';
import { getImageUploadsDir } from '@main/paths';
import {
  ALLOWED_IMAGE_EXTS,
  MIME_BY_EXT,
  PREFERRED_EXT_BY_MIME,
  MAX_IMAGE_BYTES,
} from '@main/ipc/_image-constants';
import log from '@main/utils/logger';

const logger = log.scope('store-image-uploads');

const REAPER_MAX_AGE_MS_DEFAULT = 14 * 24 * 60 * 60 * 1000;

/**
 * 确保 image-uploads 根目录存在。idempotent，多次调用安全。
 * 失败抛错让上层处理（写盘 / reaper 都依赖此目录）。
 */
async function ensureUploadsDir(): Promise<string> {
  const dir = getImageUploadsDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * base64 → 写盘到 `<userData>/image-uploads/<uuid>.<ext>`。
 *
 * 校验链：
 * 1. mime 必须在 PREFERRED_EXT_BY_MIME 白名单内（同时给出落盘 ext）
 * 2. base64 解码后实测字节数 vs 上报 bytes 必须一致（容差 0，防 IPC 篡改）
 * 3. 字节数 ≤ MAX_IMAGE_BYTES
 *
 * 失败抛 Error，让 IPC handler 回滚已写的兄弟附件。
 */
export async function writeUploadedImage(
  input: UploadedAttachmentInput,
): Promise<UploadedAttachmentRef> {
  if (!input || input.kind !== 'image' || typeof input.base64 !== 'string') {
    throw new Error('invalid attachment input shape');
  }
  const ext = PREFERRED_EXT_BY_MIME[input.mime];
  if (!ext) {
    throw new Error(`unsupported attachment mime: ${input.mime}`);
  }
  // REVIEW_91（reviewer-codex）：在 Buffer.from decode **之前**按 base64 字符串长度做硬上限，
  // 避免恶意 / 误投的超大 base64 先在主进程分配完整 Buffer 再被拒（IPC 预检只累加 renderer
  // 上报的 bytes，base64 本身不受约束）。base64 解码后字节 ≈ length * 3/4，留宽松系数挡明显
  // 超标的串；精确字节对账仍由下方 buf.length 校验完成。当前 caller 是 first-party renderer
  // 瞬时分配，故 LOW；前置 cap 是防御性硬化。
  if (input.base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) {
    throw new Error(
      `attachment base64 length ${input.base64.length} exceeds cap for ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`,
    );
  }
  // base64 解码实测字节，杜绝 renderer 上报 bytes 与实际不符的注入
  const buf = Buffer.from(input.base64, 'base64');
  if (buf.length !== input.bytes) {
    throw new Error(
      `attachment bytes mismatch: reported=${input.bytes} actual=${buf.length}`,
    );
  }
  if (buf.length === 0) {
    throw new Error('attachment is empty');
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `attachment ${(buf.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`,
    );
  }
  const dir = await ensureUploadsDir();
  const filename = `${randomUUID()}${ext}`;
  const fullPath = `${dir}${sep}${filename}`;
  await fsp.writeFile(fullPath, buf);
  return {
    kind: 'uploaded',
    path: fullPath,
    mime: input.mime,
    bytes: buf.length,
  };
}

/**
 * 加载 image-uploads 下的图片为 dataUrl，给 renderer 渲染历史 user message 里的附图。
 *
 * 严格五步（与 ipc/images.ts:66-117 同款）：
 * 1. realpath（防 symlink 跳跃）
 * 2. `real.startsWith(uploadsDir + sep)` 严格前缀（避免 `<uploadsDir>image` 这种字符串前缀误通过）
 * 3. ext 白名单（基于 canonical real）
 * 4. 单 fd open + stat + readFile（防 stat→read 之间被替换）
 * 5. size 上限校验
 *
 * 任何失败返回 { ok:false, reason }，由 UI 显示「图片不可读」灰底兜底。
 */
export async function loadUploadedImage(reqPath: string): Promise<LoadImageBlobResult> {
  if (!reqPath || typeof reqPath !== 'string') {
    return { ok: false, reason: 'unsupported_source', detail: 'path missing' };
  }
  if (!reqPath.startsWith('/')) {
    return { ok: false, reason: 'denied', detail: 'path must be absolute' };
  }

  let real: string;
  try {
    real = await fsp.realpath(reqPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'enoent' };
    return { ok: false, reason: 'io_error', detail: (err as Error).message };
  }

  // 严格前缀：必须以 `<uploadsDir>${sep}` 开头。`<uploadsDir>image-foo.png` 这种相邻命名不允许通过。
  // realpath 后判断（不是 reqPath），防 symlink 在白名单外。
  const uploadsDirReal = await (async (): Promise<string> => {
    try {
      return await fsp.realpath(getImageUploadsDir());
    } catch {
      return getImageUploadsDir(); // 目录不存在时（首次启动尚未写过）回退原路径
    }
  })();
  const prefix = uploadsDirReal.endsWith(sep) ? uploadsDirReal : uploadsDirReal + sep;
  if (!real.startsWith(prefix)) {
    return { ok: false, reason: 'denied', detail: 'path not under uploads dir' };
  }

  const ext = extname(real).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return { ok: false, reason: 'invalid_ext', detail: ext };
  }
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  let fh: import('node:fs/promises').FileHandle;
  try {
    fh = await fsp.open(real, 'r');
  } catch (err) {
    return { ok: false, reason: 'io_error', detail: (err as Error).message };
  }
  try {
    const stat = await fh.stat();
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'too_big', detail: `${stat.size} bytes` };
    }
    const buf = await fh.readFile();
    return {
      ok: true,
      mime,
      bytes: stat.size,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  } catch (err) {
    return { ok: false, reason: 'io_error', detail: (err as Error).message };
  } finally {
    await fh.close().catch(() => {
      // ignore: 关 fd 失败只 leak 一个 fd，不影响读取结果
    });
  }
}

/**
 * 静默删一个 attachment 文件（失败 swallow）。
 *
 * 使用场景：
 * - sendMessage / createSession throw 时回滚同条消息已写的兄弟附件
 * - codex closeSession 时清未消费的 pendingMessages 残留 path
 *
 * 失败 swallow 因为：reaper 14 天兜底；这里报错也无能为力（文件可能已被用户手动删 / 权限变化）。
 */
export async function deleteUploadIfExists(path: string): Promise<void> {
  if (!path || typeof path !== 'string') return;
  // 安全门：只删 image-uploads 下的文件，杜绝传任意路径删盘。
  // REVIEW_91（双 reviewer 独立）：裸 `startsWith(prefix)` 可被 `<uploadsDir>/../foo` 绕出
  // （node 实测 startsWith 返 true，resolve/unlink 后命中库外文件）。当前 3 个 caller 全传
  // writeUploadedImage 生成的 server 端 UUID 路径（renderer 只能传 base64 不能传 path）→
  // 无可达攻击面，但注释自称「杜绝传任意路径删盘」为假契约。与同文件 loadUploadedImage 的
  // realpath 守卫对齐，让契约名副其实 + 未来若有低信任 caller 也安全。
  const dir = getImageUploadsDir();
  // resolve 折叠 `..` / `.`（不走 realpath：unlink 目标可能已不存在，realpath 会 ENOENT；
  // 且 uploads 是扁平目录无内部 symlink，resolve 的纯词法归一已足够挡 `..` 穿越）。
  const resolved = resolve(path);
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  if (!resolved.startsWith(prefix)) return;
  try {
    await fsp.unlink(resolved);
  } catch {
    /* swallow */
  }
}

/**
 * 启动时清理超过 maxAgeMs 的孤儿 attachment 文件。
 *
 * fire-and-forget 调用：bootstrap 后 `void reapStaleUploads()`，不阻塞应用启动。
 * 失败 swallow（仅 console.warn）：清理失败不应影响应用功能，下次启动再试。
 *
 * 14 天阈值理由：events 行的 historyRetentionDays 默认 30 天。reaper 阈值 ≤ retention
 * 保证「events 行还在但 attachment 已被清」可能发生，UI 用 UploadedImageThumb 灰底兜底。
 * 反过来则不会出现孤儿堆积。
 */
export async function reapStaleUploads(
  maxAgeMs: number = REAPER_MAX_AGE_MS_DEFAULT,
): Promise<void> {
  const dir = getImageUploadsDir();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // 目录还没建，无活儿
    logger.warn('[image-uploads] reaper readdir failed', err);
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  let reaped = 0;
  for (const name of entries) {
    const fullPath = `${dir}${sep}${name}`;
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(fullPath);
        reaped += 1;
      }
    } catch {
      /* swallow per-file */
    }
  }
  if (reaped > 0) {
    logger.info(`[image-uploads] reaped ${reaped} stale attachment(s)`);
  }
}
