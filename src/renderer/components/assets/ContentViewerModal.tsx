import { type JSX } from 'react';
import type { NonEmptyAssetGroup } from './AssetCard';

/**
 * 资产 / CLAUDE.md 内容只读 viewer modal（CHANGELOG_57 / CHANGELOG_69 抽出；
 * plan reviewer-codex-cross-adapter-20260519 §Phase 4 Step 4.2 加 dual-adapter tab）。
 *
 * 两形态：
 * - single asset（assets.length === 1）：旧 UI 直接展示 content；不显 tab
 * - dual-adapter SKILL（assets.length === 2，同 kind+name 跨 adapter）：modal 顶部 [claude]/[codex]
 *   tab UI；点 tab 走 caller 提供的 onTabSwitch callback 触发 fetch 切换 currentAdapter
 *
 * caller 拿 viewer state 后渲染：
 *   const current = state.assets.find((a) => a.adapter === state.currentAdapter)
 *   header / onReveal 都基于 current（显示当前 tab 文件路径，reveal 当前 tab 文件位置）
 *
 * tab 切换由 caller 走 seq guard fetch（与 viewerSeqRef 同款套路防 closure 捕获 stale tab）。
 */
export interface ContentViewerState {
  /** 1（single）或 2（dual-adapter SKILL，同 kind+name 跨 adapter）。`NonEmptyAssetGroup`
   *  类型层编码至少 1 项不变量（plan §Phase 5 Step 5.1 INFO finding fix），防 caller / 测试
   *  传 `[]` 让 `assets[0]` 拿 undefined 解引用 `current.qualifiedName` 立即崩。 */
  assets: NonEmptyAssetGroup;
  /**
   * 当前选中 tab：'claude-code' / 'codex-cli'（dual-adapter）或 null（user asset 不属任何 adapter）。
   * single asset 时 = `assets[0].adapter`；dual-adapter 时 default 选 'claude-code'。
   */
  currentAdapter: 'claude-code' | 'codex-cli' | null;
  content: string | null;
  error: string | null;
}

export function ContentViewerModal({
  state,
  onReveal,
  onTabSwitch,
  onClose,
}: {
  state: ContentViewerState;
  onReveal: () => void;
  /** dual-adapter 时点 tab 触发；single asset 时 caller 不传或忽略此 prop。 */
  onTabSwitch?: (adapter: 'claude-code' | 'codex-cli') => void;
  onClose: () => void;
}): JSX.Element {
  // current = 当前选中 adapter 对应的 asset；single asset 时 fallback 第 1 个（防 currentAdapter 与 assets 漂移）
  const current = state.assets.find((a) => a.adapter === state.currentAdapter) ?? state.assets[0];
  const showTab = state.assets.length > 1;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex h-[80%] w-[420px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-2 flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <code className="text-[11px] font-medium text-deck-text truncate">{current.qualifiedName}</code>
            <code className="text-[9px] text-deck-muted/60 truncate" title={current.absPath}>
              {current.absPath}
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

        {showTab && (
          <nav className="mb-2 flex gap-1 border-b border-deck-border/60 pb-1.5 text-[10px]">
            {state.assets.map((a) => (
              <ViewerTabBtn
                key={a.adapter ?? 'user'}
                active={a.adapter === state.currentAdapter}
                onClick={() => {
                  if (a.adapter === 'claude-code' || a.adapter === 'codex-cli') {
                    onTabSwitch?.(a.adapter);
                  }
                }}
              >
                {a.adapter === 'claude-code' ? '[claude]' : a.adapter === 'codex-cli' ? '[codex]' : '[user]'}
              </ViewerTabBtn>
            ))}
          </nav>
        )}

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

function ViewerTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 transition ${
        active ? 'bg-white/10 text-deck-text' : 'text-deck-muted hover:bg-white/5 hover:text-deck-text/85'
      }`}
    >
      {children}
    </button>
  );
}
