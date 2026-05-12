import { type JSX } from 'react';
import type { AssetMeta } from '@shared/types';

/**
 * 资产 / CLAUDE.md 内容只读 viewer modal（CHANGELOG_57 / CHANGELOG_69 抽出）。
 *
 * 抽出动机：原 AssetsLibraryDialog 整体 510 行突破单文件 ≤500 阈值，把零业务依赖的纯展示
 * 子组件（54 行）拆出去，主文件回到 ~450 行。
 *
 * 渲染 z-50 浮在 AssetsLibraryDialog (z-40) 之上；display 三态：
 * - state.error：红框错误
 * - state.content === null：读取中…
 * - state.content：mono 字体 pre 展示
 *
 * 「显示文件」按钮调 onReveal（caller 自己决定调 reveal IPC，避免本组件耦合 IPC 层）。
 */
export interface ContentViewerState {
  asset: AssetMeta;
  content: string | null;
  error: string | null;
}

export function ContentViewerModal({
  state,
  onReveal,
  onClose,
}: {
  state: ContentViewerState;
  onReveal: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex h-[80%] w-[420px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-2 flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <code className="text-[11px] font-medium text-deck-text truncate">{state.asset.qualifiedName}</code>
            <code className="text-[9px] text-deck-muted/60 truncate" title={state.asset.absPath}>
              {state.asset.absPath}
            </code>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={onReveal}
              title="在 Finder / 资源管理器中显示"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              显示文件
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            >
              ✕
            </button>
          </div>
        </header>

        {state.error ? (
          <div className="rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting">
            {state.error}
          </div>
        ) : state.content === null ? (
          <div className="text-[11px] text-deck-muted">读取中…</div>
        ) : (
          <pre
            className="flex-1 overflow-y-auto scrollbar-deck whitespace-pre-wrap rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[10px] leading-relaxed text-deck-text"
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          >
            {state.content}
          </pre>
        )}
      </div>
    </div>
  );
}
