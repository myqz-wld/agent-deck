import type { JSX, ReactNode } from 'react';
import { DeckSelect } from './DeckSelect';
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
import type { RemoteHostProfileDto, RemoteHostSourceMode } from '@shared/remote-host';

export type AppView = 'live' | 'history' | 'pending' | 'teams' | 'issues' | 'data';

interface AppHeaderProps {
  view: AppView;
  stats: { total: number | null; waiting: number; working: number };
  pending: number;
  pinned: boolean;
  compact: boolean;
  sourceMode: RemoteHostSourceMode;
  selectedRemoteProfileId: string | null;
  remoteProfiles: readonly RemoteHostProfileDto[];
  onViewChange: (view: AppView) => void;
  onSourceChange: (value: string) => void;
  onOpenRemoteProfiles: () => void;
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
  sourceMode,
  selectedRemoteProfileId,
  remoteProfiles,
  onViewChange,
  onSourceChange,
  onOpenRemoteProfiles,
  onOpenPending,
  onNewSession,
  onTogglePin,
  onToggleCompact,
  onOpenLibrary,
  onOpenSettings,
}: AppHeaderProps): JSX.Element {
  const sourceValue = sourceMode === 'remote' && selectedRemoteProfileId
    ? `remote:${selectedRemoteProfileId}`
    : 'local';
  const sourceOptions = [
    { value: 'local', label: 'Local · 本机' },
    ...remoteProfiles
      .filter((profile) => profile.scope === 'remote')
      .map((profile) => ({
        value: `remote:${profile.id}`,
        label: `Remote · ${profile.label}`,
      })),
  ];
  const viewOptions = [
    { value: 'live' as const, label: '实时' },
    { value: 'pending' as const, label: pending > 0 ? `待处理 · ${pending}` : '待处理' },
    { value: 'history' as const, label: sourceMode === 'remote' ? '会话摘要' : '历史' },
    ...(sourceMode === 'local' ? [
      { value: 'teams' as const, label: '团队' },
      { value: 'issues' as const, label: '问题' },
      { value: 'data' as const, label: '数据' },
    ] : []),
  ];

  return (
    <header className="drag-region flex h-9 shrink-0 items-center gap-2 pl-[78px] pr-2.5">
      <div className="min-w-0 shrink truncate">
        <span className="text-[11px] font-medium tracking-wide">Agent Deck</span>
        <span className="ml-1.5 text-[10px] text-deck-muted/70">
          {stats.total === null ? '会话总数未提供' : `${stats.total} 会话`}
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
        <div className="hidden items-center gap-0.5 min-[900px]:flex">
          <TabButton active={view === 'live'} onClick={() => onViewChange('live')}>实时</TabButton>
          <TabButton
            active={view === 'pending'}
            onClick={() => onViewChange('pending')}
            badge={pending > 0 ? pending : undefined}
          >
            待处理
          </TabButton>
          <TabButton active={view === 'history'} onClick={() => onViewChange('history')}>{sourceMode === 'remote' ? '会话摘要' : '历史'}</TabButton>
          {sourceMode === 'local' && <TabButton active={view === 'teams'} onClick={() => onViewChange('teams')}>团队</TabButton>}
          {sourceMode === 'local' && <TabButton active={view === 'issues'} onClick={() => onViewChange('issues')}>问题</TabButton>}
          {sourceMode === 'local' && <TabButton active={view === 'data'} onClick={() => onViewChange('data')}>数据</TabButton>}
        </div>
        <DeckSelect
          value={view}
          options={viewOptions}
          onChange={onViewChange}
          title="切换页面"
          ariaLabel="页面"
          className="w-20 min-[900px]:hidden"
          buttonClassName="flex h-5 w-full items-center rounded px-2 text-left text-[10px] text-deck-muted outline-none transition hover:bg-white/8 hover:text-deck-text focus:bg-white/10 focus:text-deck-text"
          menuMinWidth={120}
        />
        <Divider />
        <DeckSelect
          value={sourceValue}
          options={sourceOptions}
          onChange={onSourceChange}
          title="切换 Local / Remote 数据源"
          ariaLabel="数据源"
          className="w-28"
          buttonClassName="flex h-5 w-full items-center rounded px-2 text-left text-[10px] text-deck-muted outline-none transition hover:bg-white/8 hover:text-deck-text focus:bg-white/10 focus:text-deck-text"
          menuMinWidth={180}
        />
        <button
          type="button"
          onClick={onOpenRemoteProfiles}
          title="远程数据源设置"
          className="inline-flex h-5 items-center rounded px-1.5 text-[10px] text-deck-muted transition hover:bg-white/8 hover:text-deck-text"
        >
          源
        </button>
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
      className={`inline-flex h-5 items-center rounded px-2 text-[10px] transition ${
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
