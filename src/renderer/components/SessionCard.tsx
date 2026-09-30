import { confirmDialog } from '@renderer/lib/confirm-dialog';
import { useMemo, useState, type JSX } from 'react';
import type { AgentEvent, SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { describeLiveActivity } from './session-live-activity';
import { SessionActivityLine } from './SessionActivityLine';
export { formatEventLine } from './session-live-activity';
import { SessionMetadataChips } from './SessionMetadataChips';
import { SessionContextUsageChip } from './SessionContextUsageChip';
import { SessionPinButton } from './SessionPinButton';
import { ArchiveIcon, CrownIcon, RefreshIcon, ShieldIcon, TrashIcon, UsersIcon } from './icons';
import { errorMessage } from '@renderer/lib/error-message';
import { SessionCardFrame, SessionCardHeader } from './SessionListPrimitives';
import { sessionSummaryHeadline } from './session-summary-headline';
import {
  SessionActionsContextMenu,
  type SessionContextMenuPosition,
} from './SessionActionsContextMenu';

interface Props {
  session: SessionRecord;
  selected: boolean;
  onSelect: () => void;
  branch?: string | null;
  /**
   * 由上游 deriveTeamRole 统一计算的团队角色。universal team membership 优先，纯 spawn 链
   * 才按 owner/child 位置回退；lead 使用蓝色边框和标签，teammate 使用浅蓝标签。
   */
  teamRole?: 'lead' | 'teammate';
}

const EMPTY_EVENTS: AgentEvent[] = [];

export function SessionCard({
  session,
  selected,
  onSelect,
  branch,
  teamRole,
}: Props): JSX.Element {
  const recent = useSessionStore((s) => s.recentEventsBySession.get(session.id) ?? EMPTY_EVENTS);
  const latestSummary = useSessionStore((s) => s.latestSummaryBySession.get(session.id));
  const [menuPosition, setMenuPosition] = useState<SessionContextMenuPosition | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPosition({ x: e.clientX, y: e.clientY });
  };

  const close = (): void => setMenuPosition(null);

  const archive = async (): Promise<void> => {
    setActionError(null);
    try {
      await window.api.archiveSession(session.id);
      close();
    } catch (err) {
      setActionError(`归档失败：${errorMessage(err)}`);
    }
  };
  const reactivate = async (): Promise<void> => {
    setActionError(null);
    try {
      await window.api.reactivateSession(session.id);
      close();
    } catch (err) {
      setActionError(`重新激活失败：${errorMessage(err)}`);
    }
  };
  const remove = async (): Promise<void> => {
    setActionError(null);
    try {
      const ok = await confirmDialog({
        title: '删除会话',
        message: `确定要删除会话「${session.title}」吗？`,
        detail: '此操作无法撤销，相关事件、文件改动和总结也会删除。',
        okLabel: '删除',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      await window.api.deleteSession(session.id);
      close();
    } catch (err) {
      setActionError(`删除失败：${errorMessage(err)}`);
    }
  };

  // 卡片展示最多三行去重后的实时活动，并用 useMemo 避免 recent 引用稳定时重复计算。
  // 最后一行展示较稳定的总结，缺失时回退到 cwd。
  const liveLines = useMemo(() => describeLiveActivity(session, recent), [session, recent]);
  const summaryPresentation = sessionSummaryHeadline(
    latestSummary?.content,
    latestSummary?.generationSource,
    session.cwd || '无工作目录',
  );

  // teams[] 是 universal team backend 的统一投影，首个 membership 提供主团队标签。
  const primaryTeam = session.teams?.[0];
  const displayTeamName = primaryTeam?.teamName ?? null;
  const teamCount = session.teams?.length ?? 0;
  const teamHoverTitle =
    teamCount > 1
      ? `所在团队 (${teamCount}):\n${session.teams!.map((t) => `· ${t.teamName} [${t.role === 'lead' ? '负责人' : '协作者'}]`).join('\n')}`
      : displayTeamName
        ? `团队: ${displayTeamName}`
        : '';

  return (
    <SessionCardFrame
      sessionId={session.id}
      selected={selected}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      emphasis={teamRole === 'lead' ? 'lead' : 'default'}
      label={`打开会话 ${session.title}`}
    >
      <SessionCardHeader
        activity={session.activity}
        lifecycle={session.lifecycle}
        archived={session.archivedAt !== null}
        title={session.title}
        adapterId={session.agentId}
      >
        <SessionPinButton session={session} />
        <span
          className={`rounded px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider ${
            session.source === 'sdk'
              ? 'bg-status-working/20 text-status-working'
              : 'bg-white/8 text-deck-muted'
          }`}
          title={session.source === 'sdk' ? '应用内创建的会话' : '终端启动的会话'}
        >
          {session.source === 'sdk' ? '内' : '外'}
        </span>
        {displayTeamName && (
          <span
            className="max-w-[6rem] truncate rounded bg-purple-500/20 px-1 py-0.5 text-[9px] font-medium text-purple-300"
            title={teamHoverTitle}
          >
            <ShieldIcon className="mr-0.5 inline h-3 w-3" />{displayTeamName}
            {teamCount > 1 && <span className="ml-0.5 text-purple-300/70">+{teamCount - 1}</span>}
          </span>
        )}
        {teamRole === 'lead' && (
          <span
            className="rounded bg-blue-400/15 px-1 py-0.5 text-[9px] font-medium text-blue-200"
            title={teamHoverTitle || '本会话是某团队的负责人'}
          >
            <CrownIcon className="mr-0.5 inline h-3 w-3" />负责人
          </span>
        )}
        {teamRole === 'teammate' && (
          <span
            className="rounded bg-blue-400/10 px-1 py-0.5 text-[9px] font-medium text-blue-200/85"
            title={teamHoverTitle || '本会话是某团队的协作者'}
          >
            <UsersIcon className="mr-0.5 inline h-3 w-3" />协作者
          </span>
        )}
      </SessionCardHeader>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
        <SessionMetadataChips session={session} branch={branch} compact />
        <SessionContextUsageChip session={session} />
      </div>
      {liveLines.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5">
          {liveLines.map((line, i) => (
            <SessionActivityLine key={`${i}-${line.text}`} line={line} muted={i > 0} />
          ))}
        </div>
      )}
      <div className="mt-0.5 truncate text-[10px] text-deck-muted/70" title={summaryPresentation.title}>
        {summaryPresentation.line}
      </div>
      {actionError && (
        <div className="mt-1 truncate text-[10px] text-status-waiting" title={actionError}>
          {actionError}
        </div>
      )}
      {menuPosition && (
        <SessionActionsContextMenu
          position={menuPosition}
          onClose={close}
          actions={[
            ...(session.archivedAt === null ? [{
              icon: <ArchiveIcon className="mr-1 inline h-3 w-3" />,
              label: '归档',
              run: archive,
            }] : []),
            ...((session.lifecycle === 'closed' || session.lifecycle === 'dormant') && session.archivedAt === null ? [{
              icon: <RefreshIcon className="mr-1 inline h-3 w-3" />,
              label: '重新激活',
              run: reactivate,
            }] : []),
            {
              danger: true,
              icon: <TrashIcon className="mr-1 inline h-3 w-3" />,
              label: '删除',
              run: remove,
            },
          ]}
        />
      )}
    </SessionCardFrame>
  );
}
