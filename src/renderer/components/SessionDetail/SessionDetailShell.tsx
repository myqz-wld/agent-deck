import { type JSX, type ReactNode } from 'react';
import { ArrowLeftIcon } from '../icons';

export type SessionDetailTabId =
  | 'activity'
  | 'tasks'
  | 'diff'
  | 'summary'
  | 'messages'
  | 'browser';

export type BaseSessionDetailTabId = Exclude<SessionDetailTabId, 'browser'>;

export interface SessionDetailTabModel {
  id: SessionDetailTabId;
  label: string;
  content: ReactNode;
  unavailableReason?: string;
  fullBleed?: boolean;
}

export const SESSION_DETAIL_TABS = Object.freeze([
  { id: 'activity', label: '活动' },
  { id: 'tasks', label: '任务' },
  { id: 'diff', label: '改动' },
  { id: 'summary', label: '总结' },
  { id: 'messages', label: '跨会话' },
] satisfies ReadonlyArray<{ id: BaseSessionDetailTabId; label: string }>);

export function createSessionDetailTabs(
  content: Readonly<Record<BaseSessionDetailTabId, ReactNode>>,
  unavailable: Partial<Record<BaseSessionDetailTabId, string>> = {},
): readonly SessionDetailTabModel[] {
  return SESSION_DETAIL_TABS.map((tab) => ({
    ...tab,
    content: content[tab.id],
    ...(unavailable[tab.id] ? { unavailableReason: unavailable[tab.id] } : {}),
  }));
}

export function SessionDetailShell({
  title,
  sourceBadge,
  subtitle,
  metadata,
  headerActions,
  banner,
  notice,
  tabs,
  activeTab,
  onTabChange,
  alert,
  composer,
  overlay,
  onClose,
}: {
  title: string;
  sourceBadge: ReactNode;
  subtitle: string;
  metadata?: ReactNode;
  headerActions?: ReactNode;
  banner?: ReactNode;
  notice?: ReactNode;
  tabs: readonly SessionDetailTabModel[];
  activeTab: SessionDetailTabId;
  onTabChange: (tab: SessionDetailTabId) => void;
  alert?: ReactNode;
  composer: ReactNode;
  overlay?: ReactNode;
  onClose: () => void;
}): JSX.Element {
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  return (
    <div data-session-detail-shell className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {sourceBadge}
            <div className="truncate text-[12px] font-medium">{title}</div>
          </div>
          <div className="truncate text-[10px] text-deck-muted">{subtitle}</div>
          {metadata && <div className="mt-1 flex flex-wrap items-center gap-1">{metadata}</div>}
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {headerActions}
          <button type="button" onClick={onClose} className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10" title="返回列表" aria-label="返回列表">
            <ArrowLeftIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      {banner}
      {notice}
      <nav className="flex shrink-0 gap-1 border-b border-deck-border/60 px-2 py-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            title={tab.unavailableReason}
            className={`rounded px-2 py-1 text-[11px] ${
              selected?.id === tab.id
                ? 'bg-white/10 text-deck-text'
                : tab.unavailableReason
                  ? 'text-deck-muted/60 hover:bg-white/5'
                  : 'text-deck-muted hover:bg-white/5'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className={selected?.fullBleed
        ? 'relative min-w-0 flex-1 overflow-hidden'
        : 'min-w-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-deck px-3 py-2'}>
        {selected?.unavailableReason
          ? <SessionCapabilityPlaceholder reason={selected.unavailableReason} />
          : selected?.content}
      </div>
      {alert}
      {composer}
      {overlay}
    </div>
  );
}

export function SessionCapabilityPlaceholder({ reason }: { reason: string }): JSX.Element {
  return (
    <div className="mx-auto max-w-lg py-12 text-center text-[10px] leading-relaxed text-deck-muted">
      {reason}
    </div>
  );
}
