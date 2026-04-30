/**
 * Image 加载（IPC + 双白名单 + 扩展名 / size 校验 + TOCTOU 防护）。
 *
 * 安全门（保持不变 / CHANGELOG_47）：
 * - realpath 后再校验白名单和扩展名，防 symlink 跳跃越权
 * - 双白名单：原 reqPath 或 canonical real 至少一个曾在该 session 出现过
 * - 扩展名 + MIME 都基于 canonical real
 * - 单 fd open + stat + readFile 防 stat→read 之间被替换（REVIEW_4 L9）
 */
import { extname } from 'node:path';
import { promises as fsp } from 'node:fs';
import { IpcInvoke } from '@shared/ipc-channels';
import { eventRepo } from '@main/store/event-repo';
import { fileChangeRepo } from '@main/store/file-change-repo';
import type { ImageSource, LoadImageBlobResult } from '@shared/types';
import { on } from './_helpers';

/** 允许 renderer 加载的图片扩展名白名单。SVG 单独算（mime 不同）。 */
const ALLOWED_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.svg',
]);
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 加载一张图片：双白名单（防 renderer 越权读任意磁盘）+ ext + size 校验。
 * 任何失败返回 { ok:false, reason }，由 UI 显示「图片不可读」灰底兜底。
 */
async function loadImageBlob(
  sessionId: string,
  source: ImageSource | null | undefined,
): Promise<LoadImageBlobResult> {
  if (!source || typeof source !== 'object') {
    return { ok: false, reason: 'unsupported_source', detail: 'source missing' };
  }
  if (source.kind !== 'path' || typeof source.path !== 'string') {
    // snapshot 形态二期再做
    return { ok: false, reason: 'unsupported_source', detail: `kind=${source.kind}` };
  }
  const reqPath = source.path;
  if (!reqPath.startsWith('/')) {
    return { ok: false, reason: 'denied', detail: 'path must be absolute' };
  }

  // TOCTOU 防护（CHANGELOG_47）：必须先 realpath 拿到 canonical 路径，再用它校验
  // 白名单 + 扩展名。否则白名单里的 symlink 可被改指向 /etc/passwd 等任意文件越权读。
  let real: string;
  try {
    real = await fsp.realpath(reqPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'enoent' };
    return { ok: false, reason: 'io_error', detail: (err as Error).message };
  }

  // 双白名单：原 reqPath 或 canonical real 至少一个曾在该 session 出现过。
  // 兼容白名单条目存的就是带 symlink 形式（旧数据）+ 拦住 symlink 跳跃越权。
  if (
    !isPathInSessionWhitelist(sessionId, reqPath) &&
    !isPathInSessionWhitelist(sessionId, real)
  ) {
    return { ok: false, reason: 'denied', detail: 'path not in session whitelist' };
  }

  // 扩展名 + MIME 都基于 canonical real：reqPath 是 .png 但 symlink 指向 .conf 的情况会被拒
  const ext = extname(real).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return { ok: false, reason: 'invalid_ext', detail: ext };
  }
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  // REVIEW_4 L9：stat 与 readFile 绑定到同一 fd，防 stat 通过后底下文件被替换
  // （单用户桌面场景风险低，但代价就一行 try/finally 顺手补上）。
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
 * 判断 path 是否在该 session 的「曾出现过」白名单里。
 * 命中条件（任一）：
 * - file_changes 行的 filePath 等于 path
 * - file_changes 行的 before/after JSON 解析后是 ImageSource 且 path 等于 path
 * - 该 session 任意 tool-use-start 事件的 toolInput.file_path 等于 path
 *   （ImageRead 不进 file_changes，靠 tool-use 事件兜底）
 */
function isPathInSessionWhitelist(sessionId: string, target: string): boolean {
  if (!sessionId) return false;
  const fcs = fileChangeRepo.listForSession(sessionId);
  for (const fc of fcs) {
    if (fc.filePath === target) return true;
    for (const blob of [fc.beforeBlob, fc.afterBlob]) {
      if (!blob || typeof blob !== 'string') continue;
      // 只在 image kind 时尝试解 JSON，避免对文本 diff 的字符串误判
      if (fc.kind !== 'image') continue;
      try {
        const v = JSON.parse(blob) as { kind?: string; path?: string };
        if (v && v.kind === 'path' && v.path === target) return true;
      } catch {
        /* swallow */
      }
    }
  }
  // 兜底：ImageRead 不进 file_changes，靠 tool-use-start 事件兜底。
  // CHANGELOG_47：之前用 `listForSession(sessionId, 500)` 在 JS 侧线性扫，长会话
  // 事件 > 500 后旧图永久读不出。改走 SQL json_extract + EXISTS LIMIT 1，无视事件总数。
  if (eventRepo.hasToolUseStartWithFilePath(sessionId, target)) return true;
  return false;
}

export function registerImagesIpc(): void {
  // Image: 按需读取一张图片为 dataURL 给 renderer 渲染。
  // 安全门：双白名单（path 必须出现在该 session 的 file_changes 或 tool-use-start 事件里）+ 扩展名 + size 校验。
  on(IpcInvoke.ImageLoadBlob, async (_e, sessionId, source): Promise<LoadImageBlobResult> => {
    return loadImageBlob(String(sessionId ?? ''), source as ImageSource);
  });
}
