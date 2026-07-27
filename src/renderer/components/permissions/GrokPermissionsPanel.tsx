import type { AdapterSessionMode } from '@shared/types';
import type { JSX } from 'react';

const MODE_LABELS: Record<AdapterSessionMode, string> = {
  default: '默认（可执行）',
  plan: '计划模式',
  ask: '问答模式',
};

export function GrokPermissionsPanel({
  sessionMode,
}: {
  sessionMode: AdapterSessionMode | null;
}): JSX.Element {
  const effectiveMode = sessionMode ?? 'default';
  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
        <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">
          Grok Build 当前运行权限
        </header>
        <div className="grid gap-2 text-[11px]">
          <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
            <span className="text-deck-muted">工作模式</span>
            <span>
              <span className="font-mono text-deck-text/90">
                {MODE_LABELS[effectiveMode]}
              </span>
              <span className="ml-1 text-[10px] text-deck-muted">
                {effectiveMode} · ACP session mode
              </span>
            </span>
          </div>
          <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
            <span className="text-deck-muted">工具授权</span>
            <span className="text-deck-text/90">
              由 Grok Build 通过 ACP 运行时请求
            </span>
          </div>
          <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
            <span className="text-deck-muted">文件/网络沙盒</span>
            <span className="text-deck-text/90">由 Grok Build 提供方原生控制</span>
          </div>
        </div>
      </section>
      <div className="rounded border border-white/10 bg-black/20 p-2 text-[10px] leading-relaxed text-deck-muted">
        Grok 会话不读取 Claude settings.json，也不套用 Codex sandbox/approval policy。
        Agent Deck 只呈现并响应 ACP permission request，不合成跨提供方权限规则。
      </div>
    </div>
  );
}
