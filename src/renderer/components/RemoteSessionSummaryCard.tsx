import { useState, type JSX, type MouseEvent } from 'react';

import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';
import { CrownIcon, PushpinIcon, ShieldIcon, UsersIcon } from './icons';
import { lifecycleLabel } from './TeamDetail/helpers';
import { HistorySessionActionsMenu } from './HistorySessionActionsMenu';
import { RuntimeMetadataChips } from './SessionMetadataChips';
import { SessionCardFrame, SessionCardHeader } from './SessionListPrimitives';
import type { SessionContextMenuPosition } from './SessionActionsContextMenu';

const ACTIVITY_LABELS = {
  idle: '空闲',
  working: '工作中',
  waiting: '等待输入',
  finished: '一轮完成',
} as const;

function compactTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/u, '')}K`;
  return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1).replace(/\.0$/u, '')}M`;
}

function ContextChip({ session }: { session: RemoteHostSessionPresentationDto }): JSX.Element {
  const { context } = session;
  const label = context
    ? `上下文 ${context.usedTokens === null ? '更新中' : compactTokens(context.usedTokens)} / ${
        context.windowTokens === null ? '未知' : compactTokens(context.windowTokens)
      }`
    : '上下文 暂无数据';
  return (
    <span
      aria-label="上下文窗口用量"
      className={`whitespace-nowrap rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] ${
        context ? 'text-deck-muted/80' : 'text-deck-muted/65'
      }`}
      title="Worker 权威上下文快照"
    >
      {label}
    </span>
  );
}

export function RemoteSessionSummaryCard({
  session,
  selected = false,
  onSelect,
  onArchive,
  onDelete,
  onUnarchive,
  teamRole,
}: {
  session: RemoteHostSessionPresentationDto;
  selected?: boolean;
  onSelect: () => void;
  onArchive?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onUnarchive?: () => Promise<void>;
  teamRole?: 'lead' | 'teammate';
}): JSX.Element {
  const [menuPosition, setMenuPosition] = useState<SessionContextMenuPosition | null>(null);
  const primaryTeam = session.teams[0];
  const teamCount = session.teams.length;
  const teamTitle = teamCount > 0
    ? `所在团队（${teamCount}）：\n${session.teams.map((team) =>
        `· ${team.teamName}［${team.role === 'lead' ? '负责人' : '协作者'}］`).join('\n')}`
    : '';
  const historyActions = onArchive && onDelete && onUnarchive
    ? { onArchive, onDelete, onUnarchive }
    : null;
  const summaryLine = historyActions
    ? session.workspaceLabel ?? 'Workspace'
    : session.summary ?? session.workspaceLabel ?? '暂无会话摘要';
  const activityLine = historyActions
    ? `${new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })} · ${
        session.archived
          ? `已归档（${lifecycleLabel(session.lifecycle)}）`
          : lifecycleLabel(session.lifecycle)
      }`
    : session.activity === 'waiting'
    ? '⚠️ 等待你的输入'
    : session.activity === 'finished'
      ? '✅ 一轮完成'
      : ACTIVITY_LABELS[session.activity];
  return (
    <SessionCardFrame
      element={historyActions ? 'div' : 'button'}
      sessionId={session.id}
      selected={selected}
      onSelect={onSelect}
      onContextMenu={historyActions ? (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      } : undefined}
      emphasis={teamRole === 'lead' ? 'lead' : 'default'}
      label={`打开会话 ${session.title}`}
    >
      <SessionCardHeader
        activity={session.activity}
        lifecycle={session.lifecycle}
        archived={session.archived}
        title={session.title}
        adapterId={session.adapterId}
      >
        <span
          className={`rounded px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider ${
            session.source === 'sdk'
              ? 'bg-status-working/20 text-status-working'
              : 'bg-white/8 text-deck-muted'
          }`}
          title={session.source === 'sdk' ? 'Remote 应用内创建的会话' : 'Remote 终端启动的会话'}
        >
          {session.source === 'sdk' ? '内' : '外'}
        </span>
        <span className="rounded bg-blue-500/15 px-1 py-0.5 text-[8px] text-blue-200" title="远程 Core 会话">远</span>
        {session.pinned && (
          <span
            role="img"
            aria-label="已置顶会话（Remote 只读）"
            title="已置顶（Remote 只读）"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-amber-400/15 text-amber-300"
          >
            <PushpinIcon filled className="h-3 w-3" />
          </span>
        )}
        {primaryTeam && (
          <span className="max-w-[6rem] truncate rounded bg-purple-500/20 px-1 py-0.5 text-[9px] text-purple-300" title={teamTitle}>
            <ShieldIcon className="mr-0.5 inline h-3 w-3" />{primaryTeam.teamName}
            {teamCount > 1 && <span className="ml-0.5 text-purple-300/70">+{teamCount - 1}</span>}
          </span>
        )}
        {teamRole === 'lead' && (
          <span className="rounded bg-blue-400/15 px-1 py-0.5 text-[9px] text-blue-200" title={teamTitle || '团队负责人'}>
            <CrownIcon className="mr-0.5 inline h-3 w-3" />负责人
          </span>
        )}
        {teamRole === 'teammate' && (
          <span className="rounded bg-blue-400/10 px-1 py-0.5 text-[9px] text-blue-200/85" title={teamTitle || '团队协作者'}>
            <UsersIcon className="mr-0.5 inline h-3 w-3" />协作者
          </span>
        )}
      </SessionCardHeader>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <RuntimeMetadataChips
          adapterId={session.adapterId}
          runtimeProvider={session.runtimeProvider}
          model={session.model}
          thinking={session.thinking}
          compact
        />
        <ContextChip session={session} />
      </div>
      <div className="mt-1 truncate text-[10px] text-deck-text/85" title={activityLine}>{activityLine}</div>
      <div className="mt-0.5 truncate text-[10px] text-deck-muted/70" title={summaryLine}>{summaryLine}</div>
      {historyActions && menuPosition && (
        <HistorySessionActionsMenu
          archived={session.archived}
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          {...historyActions}
        />
      )}
    </SessionCardFrame>
  );
}
