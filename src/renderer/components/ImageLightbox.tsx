import { useEffect, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useImageBlob } from '@renderer/hooks/useImageBlob';
import { useLightboxControls } from '@renderer/hooks/useLightboxControls';
import { sharedImageBlobCache } from '@renderer/lib/image-blob-cache';
import { CloseIcon, SaveIcon } from './icons';

/**
 * plan handoff-render-and-image-batch-20260521 §Phase 4 Step 2:用户上传图片的放大查看
 * lightbox(message-row.tsx 缩略图点击展开)。
 *
 * **设计要点**(plan §Phase 4 Step 2 + §已知踩坑 R2 codex MED-2 + R3 codex/claude 校准):
 * - **`fixed inset-0 z-[60]` overlay**(不是 `absolute inset-0`):lightbox 挂在 MessageBubble
 *   内,嵌套于 SessionDetail `overflow-y-auto` scroll container,必须 `fixed` 跳出滚动容器 +
 *   `z-[60]` 高于 NewSessionDialog `z-40` 和放大输入框 `z-50` 防被遮盖。
 *   NewSessionDialog 的 `absolute inset-0` 模式仅在 App root-level sibling 才成立。
 * - **`always-open` 设计 — 父组件条件 mount 控制可见性**(R1 reviewer-claude LOW-2 修法):
 *   组件无 `open` prop;caller 必须通过条件 mount(`{lightboxPath && <ImageLightbox ... />}`)
 *   决定是否显示。**理由**:`useImageBlob` 必须无条件调用(React hook 规则),组件内
 *   `if (!open) return null` 会违反 hook 规则(hook 已调用后 return null);所以条件 mount
 *   是唯一正确路径。API 同步去掉 `open` 让 prop 含义明确 — 减少 reader 误以为父传
 *   `open={false}` 时仍 mount 但隐藏的歧义。
 * - **Esc 键关闭**:在 document capture 阶段拦截，并在 cleanup 中移除 listener；
 *   从放大输入框打开时，一次 Esc 只关灯箱，不同时关闭外层输入框。
 * - **共享 cache**:`useImageBlob(loader, path, sharedImageBlobCache)` 与
 *   `UploadedImageThumb` 共享 cache(两者 cache key 同款 = `path`),点缩略图开 lightbox 时
 *   不重新拉图。
 * - **不引入新依赖**:不引入 `@radix-ui/react-dialog` / shadcn-ui Dialog / `react-lightbox` /
 *   `lucide-react`,全部走项目自实现 overlay + `useImageBlob` + 自实现 Esc keydown listener +
 *   项目内 source-owned SVG close icon。
 */
interface LightboxFrameProps {
  onSave?: () => void;
  saving?: boolean;
  notice?: string;
  onClose: () => void;
  alt?: string;
  dataUrl?: string;
  loading?: boolean;
  failed?: boolean;
}

function LightboxFrame({
  onClose,
  alt,
  dataUrl,
  loading = false,
  failed = false,
  onSave,
  saving = false,
  notice,
}: LightboxFrameProps): JSX.Element {
  const controls = useLightboxControls(saving, notice);
  const visibility = controls.visible ? 'opacity-100' : 'pointer-events-none opacity-0';
  // Esc 键关闭(React 标准 idiom — useEffect cleanup function 内 remove listener)。
  // REVIEW_102 INFO（reviewer-claude）：用 ref 持有最新 onClose，effect deps=[] 只在
  // mount/unmount 各挂/卸一次 listener。caller 普遍传 inline `onClose={() => setX(null)}`
  // （如 message-row.tsx:291），若 deps=[onClose] 则每次父 render onClose 新引用 → 反复
  // remove/add window keydown listener。ref 模式让 listener 对 onClose 引用变化免疫。
  // capture 阶段拦截 Escape：当灯箱从放大输入框里打开时，不让同一次
  // Escape 继续气泡到外层对话框，否则会同时关闭灯箱和输入框。
  const onCloseRef = useRef(onClose);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      controls.onKeyboard();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        // Keep keyboard focus on the image actions instead of the obscured page.
        e.preventDefault();
        e.stopPropagation();
        const buttons = [...(frameRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = index < 0 ? (e.shiftKey ? buttons.length - 1 : 0)
          : (index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      previousFocus?.focus();
    };
  }, [controls.onKeyboard]);

  return createPortal(
    <div
      ref={frameRef}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      onPointerMove={controls.onPointerMove}
      onPointerDown={controls.onPointerMove}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <div
        className="relative flex max-h-[90vh] max-w-[90vw] items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {loading && (
          <div className="flex h-32 w-32 items-center justify-center rounded border border-deck-border bg-white/[0.03] text-xs text-deck-muted">
            加载中…
          </div>
        )}
        {!loading && (failed || !dataUrl) && (
          <div className="flex h-32 w-32 items-center justify-center rounded border border-deck-border bg-white/[0.03] text-center text-xs text-deck-muted">
            {failed ? '加载失败' : '无图片'}
          </div>
        )}
        {!loading && dataUrl && (
          <img
            src={dataUrl}
            alt={alt ?? '图片预览'}
            className="max-h-[90vh] max-w-[90vw] rounded border border-deck-border object-contain"
          />
        )}
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          onPointerEnter={controls.onPointerEnter}
          onPointerLeave={controls.onPointerLeave}
          aria-label="关闭预览"
          className={`absolute -top-3 -right-3 flex h-7 w-7 items-center justify-center rounded-full border border-deck-border bg-deck-bg/90 text-deck-text transition-opacity duration-200 hover:bg-white/15 active:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-deck-accent motion-reduce:transition-none ${visibility}`}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      {onSave && dataUrl && <div
        role="toolbar"
        aria-label="图片操作"
        onClick={(event) => event.stopPropagation()}
        onPointerEnter={controls.onPointerEnter}
        onPointerLeave={controls.onPointerLeave}
        className={`absolute bottom-4 left-1/2 flex max-w-[calc(100vw_-_2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-white/15 bg-deck-bg/90 p-1.5 text-[11px] text-deck-text shadow-lg backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none ${visibility}`}
      >
        <button type="button" onClick={onSave} disabled={saving} aria-busy={saving}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-deck-text transition-colors hover:border-white/20 hover:bg-white/15 active:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-deck-accent disabled:cursor-wait disabled:opacity-60">
          <SaveIcon className="h-3.5 w-3.5" />{saving ? '保存中…' : '保存图片'}
        </button>
        {notice && <span role="status" className="min-w-0 pr-2">{notice}</span>}
      </div>}
    </div>, document.body,
  );
}

export function ImageLightbox({
  onClose,
  path,
  alt,
}: {
  onClose: () => void;
  path: string;
  alt?: string;
}): JSX.Element {
  // 共享 cache 同款 IPC(与 UploadedImageThumb 同款 cache key = path)
  const state = useImageBlob(() => window.api.loadUploadedImage(path), path, sharedImageBlobCache);

  return (
    <LightboxFrame
      onClose={onClose}
      alt={alt}
      loading={state.loading}
      failed={!state.loading && (!state.result || !state.result.ok)}
      dataUrl={state.result?.ok ? state.result.dataUrl : undefined}
    />
  );
}

/** 待发送附件已在 renderer 内存中，直接预览即将发送的完整 data URL。 */
export function DataUrlImageLightbox({
  onClose,
  dataUrl,
  alt,
  onSave,
  saving,
  notice,
}: {
  onClose: () => void;
  dataUrl: string;
  alt?: string;
  onSave?: () => void;
  saving?: boolean;
  notice?: string;
}): JSX.Element {
  return <LightboxFrame onClose={onClose} alt={alt} dataUrl={dataUrl} onSave={onSave} saving={saving} notice={notice} />;
}
