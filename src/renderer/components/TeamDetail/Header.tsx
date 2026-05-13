import type { JSX, ReactNode } from 'react';

/**
 * plan team-cohesion-fix-20260513 Phase C：TeamDetail 顶部 header（标题 + 右侧 actions
 * + 右上角返回按钮）。从原 TeamDetail/index.tsx 抽出，便于 5 sections 子组件复用 Section
 * 风格的同时复用同一 Header。
 *
 * CHANGELOG_94: 「← 返回」按钮从左上角挪到右上角（与 SessionDetail header 风格统一），
 * 与 actions 同组在右侧。标题居左占 flex-1。
 */
interface Props {
  onBack: () => void;
  children: ReactNode;
  /** 可选右侧 actions 槽（如「shutdown all teammates」按钮，Phase F 加）。 */
  actions?: ReactNode;
}

export function Header({ onBack, children, actions }: Props): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-deck-border px-3 py-2">
      <div className="min-w-0 flex-1 truncate text-[12px] text-deck-text">{children}</div>
      <div className="ml-2 flex shrink-0 items-center gap-1.5">
        {actions}
        <button
          type="button"
          onClick={onBack}
          className="no-drag flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          title="返回列表"
        >
          ←
        </button>
      </div>
    </div>
  );
}

/**
 * 子组件标准 Section 容器：标题 + 内容。所有 5 sections 复用统一视觉。
 */
export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="mb-3">
      <h3 className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted">
        {title}
        {typeof count === 'number' && (
          <span className="ml-1 text-deck-muted/60">({count})</span>
        )}
      </h3>
      {children}
    </section>
  );
}

/** 空 state 提示（统一灰色文案）。 */
export function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <div className="text-deck-muted/70 text-[11px]">{children}</div>;
}
