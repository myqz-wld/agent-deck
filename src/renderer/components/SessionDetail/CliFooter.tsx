import { type JSX } from 'react';

export function CliFooter(): JSX.Element {
  return (
    <div className="shrink-0 border-t border-deck-border bg-white/[0.02] px-3 py-2 text-[10px] leading-relaxed text-deck-muted">
      终端启动 · 只读视图。请回到运行 claude 命令的终端窗口继续对话。
    </div>
  );
}
