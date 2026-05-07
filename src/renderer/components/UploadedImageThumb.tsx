import type { JSX } from 'react';
import { createImageBlobCache, useImageBlob } from '@renderer/hooks/useImageBlob';

/**
 * 历史 user message 里附图的缩略图组件。
 *
 * 设计要点（与 ImageBlobLoader 区分）：
 * - 走 `window.api.loadUploadedImage(path)` 而非 `loadImageBlob(sessionId, source)`：
 *   user upload 不进 file_changes 表，不能复用那条白名单
 * - 独立 cache namespace：避免与 ImageBlobLoader 的 `<sessionId>|<source>` 键冲突
 * - 失败兜底（plan §D4 LOW 修）：图片可能已被 reaper 清 / 用户磁盘删了 /
 *   reapStaleUploads 提前清，渲染灰底 + reason 让用户知道发生了什么
 */
const cache = createImageBlobCache();

export function UploadedImageThumb({
  path,
  size = 56,
  alt,
  title,
}: {
  path: string;
  /** 缩略图边长 px。detail view 默认 56；大图查看可传更大 */
  size?: number;
  alt?: string;
  title?: string;
}): JSX.Element {
  const state = useImageBlob(() => window.api.loadUploadedImage(path), path, cache);

  const dim = `${size}px`;

  if (state.loading) {
    return (
      <div
        style={{ width: dim, height: dim }}
        className="flex items-center justify-center rounded border border-deck-border bg-white/[0.03] text-[9px] text-deck-muted/60"
        aria-label="loading image"
      >
        …
      </div>
    );
  }

  if (!state.result || !state.result.ok) {
    const reason = state.result && !state.result.ok ? state.result.reason : 'unknown';
    const detail = state.result && !state.result.ok ? state.result.detail : undefined;
    // reason → 中文提示
    const tip =
      reason === 'enoent'
        ? '图片已被清理'
        : reason === 'denied'
          ? '路径不在允许范围'
          : reason === 'too_big'
            ? '超出大小'
            : reason === 'invalid_ext'
              ? '不支持格式'
              : '加载失败';
    return (
      <div
        style={{ width: dim, height: dim }}
        className="flex items-center justify-center rounded border border-deck-border bg-white/[0.03] text-center text-[9px] text-deck-muted/70"
        title={`${tip}${detail ? ` (${detail})` : ''}\n${path}`}
      >
        {tip}
      </div>
    );
  }

  return (
    <img
      src={state.result.dataUrl}
      alt={alt ?? 'attachment'}
      title={title ?? `${(state.result.bytes / 1024).toFixed(1)}KB · ${state.result.mime}`}
      style={{ width: dim, height: dim }}
      className="rounded border border-deck-border object-cover"
    />
  );
}
