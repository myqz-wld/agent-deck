import { type JSX } from 'react';
import type { AssetMeta } from '@shared/types';
import { CloseIcon, FolderOpenIcon } from '../icons';

/**
 * 资产 / CLAUDE.md 内容只读 viewer modal（CHANGELOG_57 / CHANGELOG_69 抽出；
 * plan assets-codex-user-and-ui-unify-20260521 §D6 简化:删 dual-adapter tab 切换 + 改单
 * AssetMeta 模式)。
 *
 * 各 sub-tab 单 adapter 视图 → ContentViewerState 仅含一个 asset,modal 直接渲染对应 content,
 * 不再有 dual-adapter tab 切换器(同名跨 adapter SSOT 镜像 SKILL 在 Skills tab 各 sub-tab 显
 * 1 份,各自点查看进 modal,modal 内单 asset 模式)。
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
  const { asset } = state;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex h-[80%] w-[420px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-2 flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <code className="text-[11px] font-medium text-deck-text truncate">{asset.qualifiedName}</code>
            <code className="text-[9px] text-deck-muted/60 truncate" title={asset.absPath}>
              {asset.absPath}
            </code>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={onReveal}
              title="在 Finder / 资源管理器中显示"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              <FolderOpenIcon className="mr-1 inline h-3 w-3" />显示文件
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            >
              <CloseIcon className="h-3.5 w-3.5" />
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
