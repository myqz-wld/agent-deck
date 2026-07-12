import type { JSX, ReactNode } from 'react';
import { HeaderTokenRates } from './HeaderTokenRates';
import {
  AlertTriangleIcon,
  CollapseIcon,
  ExpandIcon,
  LibraryIcon,
  PlusIcon,
  PushpinIcon,
  SettingsIcon,
} from './icons';

export type AppView = 'live' | 'history' | 'pending' | 'teams' | 'issues' | 'data';

interface AppHeaderProps {
  view: AppView;
  stats: { total: number; waiting: number; working: number };
  pending: number;
  pinned: boolean;
  compact: boolean;
  onViewChange: (view: AppView) => void;
  onOpenPending: () => void;
  onNewSession: () => void;
  onTogglePin: () => void;
  onToggleCompact: () => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
}

export function AppHeader({
  view,
  stats,
  pending,
  pinned,
  compact,
  onViewChange,
  onOpenPending,
  onNewSession,
  onTogglePin,
  onToggleCompact,
  onOpenLibrary,
  onOpenSettings,
}: AppHeaderProps): JSX.Element {
  return (
    <header className="drag-region flex h-9 shrink-0 items-center gap-2 pl-[78px] pr-2.5">
      <div className="min-w-0 shrink truncate">
        <span className="text-[11px] font-medium tracking-wide">Agent Deck</span>
        <span className="ml-1.5 text-[10px] text-deck-muted/70">
          {stats.total} 会话
          {stats.waiting > 0 && (
            <span className="ml-1.5 text-status-waiting">· {stats.waiting} 等待</span>
          )}
          {stats.working > 0 && (
            <span className="ml-1.5 text-status-working">· {stats.working} 进行中</span>
          )}
        </span>
        {pending > 0 && (
          <button
            type="button"
            onClick={onOpenPending}
            title="打开待处理列表"
            className="no-drag ml-2 inline-flex items-center gap-1 rounded bg-status-waiting/25 px-1.5 py-0.5 text-[10px] text-status-waiting hover:bg-status-waiting/40"
          >
            <AlertTriangleIcon className="h-3 w-3" />
            {pending} 待处理
          </button>
        )}
      </div>
      <HeaderTokenRates />
      <div className="flex shrink-0 items-center gap-0.5 no-drag">
        <HeaderIconButton title="新建会话" onClick={onNewSession}>
          <PlusIcon className="h-3.5 w-3.5" />
        </HeaderIconButton>
        <Divider />
        <TabButton active={view === 'live'} onClick={() => onViewChange('live')}>实时</TabButton>
        <TabButton
          active={view === 'pending'}
          onClick={() => onViewChange('pending')}
          badge={pending > 0 ? pending : undefined}
        >
          待处理
        </TabButton>
        <TabButton active={view === 'history'} onClick={() => onViewChange('history')}>历史</TabButton>
        <TabButton active={view === 'teams'} onClick={() => onViewChange('teams')}>团队</TabButton>
        <TabButton active={view === 'issues'} onClick={() => onViewChange('issues')}>问题</TabButton>
        <TabButton active={view === 'data'} onClick={() => onViewChange('data')}>数据</TabButton>
        <Divider />
        <HeaderIconButton
          title={pinned ? '取消置顶' : '置顶'}
          onClick={onTogglePin}
          active={pinned}
          activeClassName="bg-amber-400/15 text-amber-300"
        >
          <PushpinIcon filled={pinned} className="h-3.5 w-3.5" />
        </HeaderIconButton>
        <HeaderIconButton title={compact ? '展开' : '折叠'} onClick={onToggleCompact}>
          {compact
            ? <ExpandIcon className="h-3.5 w-3.5" />
            : <CollapseIcon className="h-3.5 w-3.5" />}
        </HeaderIconButton>
        <HeaderIconButton title="资产库" onClick={onOpenLibrary}>
          <LibraryIcon className="h-3.5 w-3.5" />
        </HeaderIconButton>
        <HeaderIconButton title="设置" onClick={onOpenSettings}>
          <SettingsIcon className="h-3.5 w-3.5" />
        </HeaderIconButton>
      </div>
    </header>
  );
}

function TabButton({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[10px] transition ${
        active ? 'bg-white/15 text-deck-text' : 'text-deck-muted hover:bg-white/8'
      }`}
    >
      {children}
      {badge && badge > 0 ? (
        <span className="ml-1 rounded bg-status-waiting/30 px-1 py-px text-[9px] font-medium tabular-nums text-status-waiting">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function HeaderIconButton({
  title,
  onClick,
  active,
  activeClassName = 'bg-white/12 text-deck-text',
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  activeClassName?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-5 w-5 items-center justify-center rounded transition ${
        active
          ? activeClassName
          : 'text-deck-muted hover:bg-white/8 hover:text-deck-text'
      }`}
    >
      {children}
    </button>
  );
}

function Divider(): JSX.Element {
  return <span className="mx-0.5 h-3 w-px bg-white/10" />;
}
