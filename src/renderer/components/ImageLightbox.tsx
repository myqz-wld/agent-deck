import { useEffect, type JSX } from 'react';
import { useImageBlob } from '@renderer/hooks/useImageBlob';
import { sharedImageBlobCache } from '@renderer/lib/image-blob-cache';

/**
 * plan handoff-render-and-image-batch-20260521 §Phase 4 Step 2:用户上传图片的放大查看
 * lightbox(message-row.tsx 缩略图点击展开)。
 *
 * **设计要点**(plan §Phase 4 Step 2 + §已知踩坑 R2 codex MED-2 + R3 codex/claude 校准):
 * - **`fixed inset-0 z-50` overlay**(不是 `absolute inset-0`):lightbox 挂在 MessageBubble
 *   内,嵌套于 SessionDetail `overflow-y-auto` scroll container,必须 `fixed` 跳出滚动容器 +
 *   `z-50` 高于 NewSessionDialog `z-40` 防被遮盖。NewSessionDialog 的 `absolute inset-0` 模式
 *   仅在 App root-level sibling 才成立。
 * - **`always-open` 设计 — 父组件条件 mount 控制可见性**(R1 reviewer-claude LOW-2 修法):
 *   组件无 `open` prop;caller 必须通过条件 mount(`{lightboxPath && <ImageLightbox ... />}`)
 *   决定是否显示。**理由**:`useImageBlob` 必须无条件调用(React hook 规则),组件内
 *   `if (!open) return null` 会违反 hook 规则(hook 已调用后 return null);所以条件 mount
 *   是唯一正确路径。API 同步去掉 `open` 让 prop 含义明确 — 减少 reader 误以为父传
 *   `open={false}` 时仍 mount 但隐藏的歧义。
 * - **Esc 键关闭**(R3 reviewer-claude INFO-3:项目内 `grep addEventListener('keydown'`
 *   命中 0 处,lightbox **首次引入**此模式):React 标准 idiom — useEffect cleanup function
 *   内 remove listener(mount/unmount 正确 add/remove)。
 * - **共享 cache**:`useImageBlob(loader, path, sharedImageBlobCache)` 与
 *   `UploadedImageThumb` 共享 cache(两者 cache key 同款 = `path`),点缩略图开 lightbox 时
 *   不重新拉图。
 * - **不引入新依赖**:不引入 `@radix-ui/react-dialog` / shadcn-ui Dialog / `react-lightbox` /
 *   `lucide-react`,全部走项目自实现 overlay + `useImageBlob` + 自实现 Esc keydown listener +
 *   unicode close 符号(项目 tool-icons.ts:4-6 明确不引入 lucide)。
 */
export function ImageLightbox({
  onClose,
  path,
  alt,
}: {
  onClose: () => void;
  path: string;
  alt?: string;
}): JSX.Element {
  // Esc 键关闭(React 标准 idiom — useEffect cleanup function 内 remove listener)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // 共享 cache 同款 IPC(与 UploadedImageThumb 同款 cache key = path)
  const state = useImageBlob(() => window.api.loadUploadedImage(path), path, sharedImageBlobCache);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <div
        className="relative flex max-h-[90vh] max-w-[90vw] items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {state.loading && (
          <div className="flex h-32 w-32 items-center justify-center rounded border border-deck-border bg-white/[0.03] text-xs text-deck-muted">
            加载中…
          </div>
        )}
        {!state.loading && (!state.result || !state.result.ok) && (
          <div className="flex h-32 w-32 items-center justify-center rounded border border-deck-border bg-white/[0.03] text-center text-xs text-deck-muted">
            {state.result && !state.result.ok ? '加载失败' : '无图片'}
          </div>
        )}
        {!state.loading && state.result?.ok && (
          <img
            src={state.result.dataUrl}
            alt={alt ?? '图片预览'}
            className="max-h-[90vh] max-w-[90vw] rounded border border-deck-border object-contain"
          />
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭预览"
          className="absolute -top-3 -right-3 flex h-7 w-7 items-center justify-center rounded-full border border-deck-border bg-deck-bg/90 text-deck-text hover:bg-white/10"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
