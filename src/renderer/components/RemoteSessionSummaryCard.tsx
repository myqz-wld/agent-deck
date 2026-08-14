import { useState, type JSX, type MouseEvent } from 'react';

import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';
import { CrownIcon, ShieldIcon, UsersIcon } from './icons';
import { lifecycleLabel } from './session-presentation';
import { HistorySessionActionsMenu } from './HistorySessionActionsMenu';
import { RuntimeMetadataChips } from './SessionMetadataChips';
import { SessionCardFrame, SessionCardHeader } from './SessionListPrimitives';
import type { SessionContextMenuPosition } from './SessionActionsContextMenu';
import { SessionContextSnapshotChip } from './SessionContextUsageChip';
import { SessionPinControl } from './SessionPinButton';
import { sessionSummaryHeadline } from './session-summary-headline';

const ACTIVITY_LABELS = {
  idle: '空闲',
  working: '工作中',
  waiting: '等待输入',
  finished: '一轮完成',
} as const;

export function RemoteSessionSummaryCard({
  session,
  selected = false,
  onSelect,
  onArchive,
  onDelete,
  onReactivate,
  onUnarchive,
  history = false,
  teamRole,
}: {
  session: RemoteHostSessionPresentationDto;
  selected?: boolean;
  onSelect: () => void;
  onArchive?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onReactivate?: () => Promise<void>;
  onUnarchive?: () => Promise<void>;
  history?: boolean;
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
    ? { onArchive, onDelete, ...(onReactivate ? { onReactivate } : {}), onUnarchive }
    : null;
  const summaryPresentation = sessionSummaryHeadline(
    history ? null : session.summary,
    session.summaryGenerationSource,
    session.workspaceLabel ?? (history ? 'Workspace' : '暂无会话摘要'),
  );
  const activityLine = history
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
          title={session.source === 'sdk' ? '应用内创建的远端会话' : '终端启动的远端会话'}
        >
          {session.source === 'sdk' ? '内' : '外'}
        </span>
        <span className="rounded bg-blue-500/15 px-1 py-0.5 text-[8px] text-blue-200" title="远端会话">远</span>
        <SessionPinControl
          pinned={session.pinned}
          disabled
          disabledReason={session.pinned ? '此会话已置顶' : '远端会话暂不支持修改置顶状态'}
        />
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
        <SessionContextSnapshotChip context={session.context} />
      </div>
      <div className="mt-1 truncate text-[10px] text-deck-text/85" title={activityLine}>{activityLine}</div>
      <div className="mt-0.5 truncate text-[10px] text-deck-muted/70" title={summaryPresentation.title}>
        {summaryPresentation.line}
      </div>
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
