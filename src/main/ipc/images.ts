/**
 * 图片读取保留四层边界：reqPath/realpath 定向授权、realpath 扩展名、
 * 大小限制，以及同一 fd 上的 stat/read，避免授权绕过和 TOCTOU。
 */
import { extname } from 'node:path';
import { promises as fsp } from 'node:fs';
import { IpcInvoke } from '@shared/ipc-channels';
import { eventRepo } from '@main/store/event-repo';
import { fileChangeReadRepo } from '@main/store/file-change-read-repo';
import type { ImageSource, LoadImageBlobResult } from '@shared/types';
import { on } from './_helpers';
import { ALLOWED_IMAGE_EXTS, MIME_BY_EXT, MAX_IMAGE_BYTES } from './_image-constants';
import { loadUploadedImage } from '@main/store/image-uploads';

/**
 * 加载一张图片：双白名单（防 renderer 越权读任意磁盘）+ ext + size 校验。
 * 任何失败返回 { ok:false, reason }，由 UI 显示「图片不可读」灰底兜底。
 */
async function loadImageBlob(
  sessionId: string,
  source: ImageSource | null | undefined,
): Promise<LoadImageBlobResult> {
  if (!source || typeof source !== 'object') {
    return { ok: false, reason: 'unsupported_source' };
  }
  if (source.kind !== 'path' || typeof source.path !== 'string') {
    // 当前只接受已授权的磁盘路径来源。
    return { ok: false, reason: 'unsupported_source' };
  }
  const reqPath = source.path;
  if (!reqPath.startsWith('/')) {
    return { ok: false, reason: 'denied' };
  }

  // 先解析 canonical 路径，再执行授权和扩展名校验，阻止 symlink 跳跃。
  let real: string;
  try {
    real = await fsp.realpath(reqPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'enoent' };
    return { ok: false, reason: 'io_error' };
  }

  // 双白名单：原 reqPath 或 canonical real 至少一个曾在该 session 出现过。
  // 兼容白名单条目存的就是带 symlink 形式（旧数据）+ 拦住 symlink 跳跃越权。
  if (
    !isPathInSessionWhitelist(sessionId, reqPath) &&
    !isPathInSessionWhitelist(sessionId, real)
  ) {
    return { ok: false, reason: 'denied' };
  }

  // 扩展名 + MIME 都基于 canonical real：reqPath 是 .png 但 symlink 指向 .conf 的情况会被拒
  const ext = extname(real).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return { ok: false, reason: 'invalid_ext' };
  }
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  // stat 与 readFile 绑定到同一 fd，避免检查和读取之间目标被替换。
  let fh: import('node:fs/promises').FileHandle;
  try {
    fh = await fsp.open(real, 'r');
  } catch {
    return { ok: false, reason: 'io_error' };
  }
  try {
    const stat = await fh.stat();
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'too_big' };
    }
    const buf = await fh.readFile();
    return {
      ok: true,
      mime,
      bytes: stat.size,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  } catch {
    return { ok: false, reason: 'io_error' };
  } finally {
    await fh.close().catch(() => {
      // ignore: 关 fd 失败只 leak 一个 fd，不影响读取结果
    });
  }
}

/**
 * 使用定向 SQL 验证 file_path、受 json_valid 保护的 before/after path，
 * 或 tool-use-start 的 file_path；所有查询都在首个命中处停止。
 */
function isPathInSessionWhitelist(sessionId: string, target: string): boolean {
  if (!sessionId) return false;
  if (fileChangeReadRepo.hasImagePathForSession(sessionId, target)) return true;
  // 兜底：ImageRead 不进 file_changes，靠 tool-use-start 事件兜底。
  if (eventRepo.hasToolUseStartWithFilePath(sessionId, target)) return true;
  return false;
}

export function registerImagesIpc(): void {
  // Image: 按需读取一张图片为 dataURL 给 renderer 渲染。
  // 安全门：双白名单（path 必须出现在该 session 的 file_changes 或 tool-use-start 事件里）+ 扩展名 + size 校验。
  on(IpcInvoke.ImageLoadBlob, async (_e, sessionId, source): Promise<LoadImageBlobResult> => {
    return loadImageBlob(String(sessionId ?? ''), source as ImageSource);
  });

  // UploadedImage: 加载用户在输入框上传的图片（与 ImageLoadBlob 走完全独立白名单）。
  // 路径必须在 <userData>/image-uploads/ 下；realpath + sep 严格前缀 + ext + size + 单 fd open/stat/readFile。
  on(IpcInvoke.UploadedImageLoad, async (_e, path): Promise<LoadImageBlobResult> => {
    return loadUploadedImage(String(path ?? ''));
  });
}
