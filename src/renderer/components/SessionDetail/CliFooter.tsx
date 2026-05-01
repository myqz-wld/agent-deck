import { type JSX } from 'react';

export function CliFooter(): JSX.Element {
  return (
    <div className="shrink-0 border-t border-deck-border bg-white/[0.02] px-3 py-2 text-[10px] leading-relaxed text-deck-muted">
      外部 CLI 会话 · 只读视图。请回到对应的终端窗口直接与 Claude 对话。
    </div>
  );
}
