import type { JSX, ReactNode } from 'react';

/**
 * plan team-cohesion-fix-20260513 Phase C：TeamDetail 顶部 header（标题 + back button + 右
 * 侧自定义 actions 槽）。从原 TeamDetail/index.tsx 抽出，便于 5 sections 子组件复用 Section 风格
 * 的同时复用同一 Header。
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
      <button
        type="button"
        onClick={onBack}
        className="no-drag text-[11px] text-deck-muted hover:text-deck-text"
      >
        ← 返回
      </button>
      <div className="flex-1 truncate text-[12px] text-deck-text">{children}</div>
      {actions && <div className="ml-2 shrink-0">{actions}</div>}
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
