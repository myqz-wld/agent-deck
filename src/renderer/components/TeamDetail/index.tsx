import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AgentDeckMessage,
  AgentDeckTeam,
  AgentDeckTeamMember,
  AgentEvent,
  TaskRecord,
} from '@shared/types';
import log from '@renderer/utils/logger';
import { Header } from './Header';
import { MembersSection } from './MembersSection';
import { LineageSection } from './LineageSection';
import { EventsSection } from './EventsSection';
import { TasksSection } from './TasksSection';
import { MessagesSection } from './MessagesSection';
import { PendingSection } from './PendingSection';
import { ArchiveIcon, StopIcon } from '../icons';
import { safeErrorData } from '../activity-feed/viewers/safe-error-data';

const logger = log.scope('renderer-team-detail');

/**
 * Team workspace. One snapshot supplies members, events, tasks, and messages; lineage and
 * pending state stay reactive through the session store. Refreshes are team-scoped and
 * coalesced so an older team's response cannot replace the current view.
 */
interface Props {
  teamId: string;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}

interface FullSnapshot extends AgentDeckTeam {
  members: AgentDeckTeamMember[];
  recentEvents: (AgentEvent & { id: number })[];
  tasks: TaskRecord[];
  recentMessages: AgentDeckMessage[];
}

export function TeamDetail({ teamId, onBack, onOpenSession }: Props): JSX.Element {
  const [snap, setSnap] = useState<FullSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'shutdown' | 'archive' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const activeTeamIdRef = useRef(teamId);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  activeTeamIdRef.current = teamId;

  useEffect(() => {
    const generation = ++refreshGenerationRef.current;
    let disposed = false;
    let inFlight = false;
    let pending = false;
    setSnap(null);
    setLoading(true);
    setError(null);
    setActionBusy(null);
    setActionError(null);

    const refresh = async (): Promise<void> => {
      if (disposed || generation !== refreshGenerationRef.current) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        const row = await window.api.getAgentDeckTeamFull(teamId);
        if (disposed || generation !== refreshGenerationRef.current) return;
        if (!row) {
          setSnap(null);
          setError('团队不存在或已删除');
        } else {
          setSnap(row);
          setError(null);
        }
        setLoading(false);
      } catch (err) {
        if (disposed || generation !== refreshGenerationRef.current) return;
        logger.warn('team snapshot load failed', {
          action: 'load-team-snapshot',
          teamId,
          agentId: null,
          sessionId: null,
          source: 'team-detail',
          count: null,
          ...safeErrorData(err),
        });
        setError('读取团队详情失败，请稍后重试。');
        setLoading(false);
      } finally {
        inFlight = false;
        if (
          !disposed
          && generation === refreshGenerationRef.current
          && pending
        ) {
          pending = false;
          void refresh();
        }
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const offTeam = window.api.onAgentDeckTeamChanged((items) => {
      if (items.some((item) => item.teamId === teamId)) void refresh();
    });
    const offMsg = window.api.onAgentDeckMessageChanged((items) => {
      if (items.some((item) => item.teamId === teamId)) void refresh();
    });
    return () => {
      disposed = true;
      pending = false;
      offTeam();
      offMsg();
      if (refreshRef.current === refresh) {
        refreshRef.current = async () => {};
      }
    };
  }, [teamId]);

  const reloadAfterMemberAdded = useCallback(
    (): Promise<void> => refreshRef.current(),
    [],
  );

  // Closing a team affects active collaborators only; the lead and history remain intact.
  const onShutdownAllTeammates = async (): Promise<void> => {
    if (!snap || actionBusy) return;
    const teammates = snap.members.filter((m) => m.role === 'teammate' && m.leftAt === null);
    if (teammates.length === 0) return;
    const actionGeneration = refreshGenerationRef.current;
    const actionTeamId = teamId;
    const actionIsCurrent = (): boolean => (
      actionGeneration === refreshGenerationRef.current
      && actionTeamId === activeTeamIdRef.current
    );
    const ok = await window.api.confirmDialog({
      title: `关闭团队「${snap.name}」的所有协作者`,
      message: `将关闭 ${teammates.length} 个协作者会话，确定继续？`,
      detail: '负责人不会关闭。协作者关闭后会自动退出团队，但消息、事件和文件变更等历史记录都保留。关闭不可恢复，需要重新邀请才能再次协作。',
      okLabel: '全部关闭',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok || !actionIsCurrent()) return;
    setActionError(null);
    setActionBusy('shutdown');
    try {
      const result = await window.api.shutdownAllTeammates(actionTeamId);
      if (result.failed.length > 0) {
        logger.warn('team action partially failed', {
          action: 'shutdown-collaborators',
          teamId: actionTeamId,
          agentId: null,
          sessionId: null,
          source: 'team-detail',
          count: result.failed.length,
        });
        if (actionIsCurrent()) {
          setActionError('部分协作者未能关闭，请稍后重试。');
        }
      }
    } catch (err) {
      logger.warn('team action failed', {
        action: 'shutdown-collaborators',
        teamId: actionTeamId,
        agentId: null,
        sessionId: null,
        source: 'team-detail',
        count: teammates.length,
        ...safeErrorData(err),
      });
      if (actionIsCurrent()) {
        setActionError('关闭协作者失败，请稍后重试。');
      }
    } finally {
      if (actionIsCurrent()) setActionBusy(null);
    }
  };

  const onArchiveTeam = async (): Promise<void> => {
    if (!snap || actionBusy) return;
    if (snap.archivedAt !== null) return;
    const actionGeneration = refreshGenerationRef.current;
    const actionTeamId = teamId;
    const actionIsCurrent = (): boolean => (
      actionGeneration === refreshGenerationRef.current
      && actionTeamId === activeTeamIdRef.current
    );
    const ok = await window.api.confirmDialog({
      title: `归档团队「${snap.name}」`,
      message: `确定要归档团队「${snap.name}」吗？`,
      detail: '归档后团队会从列表中隐藏；不删除团队、不关闭成员会话、不删除消息。可在归档列表中恢复。',
      okLabel: '归档',
      cancelLabel: '取消',
      destructive: false,
    });
    if (!ok || !actionIsCurrent()) return;
    setActionError(null);
    setActionBusy('archive');
    try {
      await window.api.archiveAgentDeckTeam(actionTeamId);
    } catch (err) {
      logger.warn('team action failed', {
        action: 'archive-team',
        teamId: actionTeamId,
        agentId: null,
        sessionId: null,
        source: 'team-detail',
        count: 1,
        ...safeErrorData(err),
      });
      if (actionIsCurrent()) {
        setActionError('归档团队失败，请稍后重试。');
      }
    } finally {
      if (actionIsCurrent()) setActionBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <Header onBack={onBack}>加载中…</Header>
      </div>
    );
  }
  if (error || !snap) {
    return (
      <div className="flex h-full flex-col">
        <Header onBack={onBack}>错误</Header>
        <div className="px-3 py-2 text-[11px] text-status-waiting/90">{error ?? '未知错误'}</div>
      </div>
    );
  }

  const activeTeammateCount = snap.members.filter(
    (m) => m.role === 'teammate' && m.leftAt === null,
  ).length;

  return (
    <div className="flex h-full flex-col">
      <Header
        onBack={onBack}
        actions={
          <div className="flex items-center gap-1.5">
            {!snap.archivedAt && activeTeammateCount > 0 && (
              <button
                type="button"
                disabled={actionBusy !== null}
                onClick={() => void onShutdownAllTeammates()}
                title={`关闭团队内全部 ${activeTeammateCount} 个协作者（负责人不关闭）`}
                className="rounded bg-status-waiting/25 px-2 py-0.5 text-[10px] text-status-waiting transition hover:bg-status-waiting/35 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {actionBusy !== 'shutdown' && <StopIcon className="mr-1 inline h-3 w-3" />}
                {actionBusy === 'shutdown' ? '关闭中…' : `关闭 ${activeTeammateCount} 个协作者`}
              </button>
            )}
            {!snap.archivedAt && (
              <button
                type="button"
                disabled={actionBusy !== null}
                onClick={() => void onArchiveTeam()}
                title="归档团队（不关闭成员、不删除数据）"
                className="rounded bg-deck-muted/20 px-2 py-0.5 text-[10px] text-deck-muted transition hover:bg-deck-muted/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {actionBusy !== 'archive' && <ArchiveIcon className="mr-1 inline h-3 w-3" />}
                {actionBusy === 'archive' ? '归档中…' : '归档'}
              </button>
            )}
          </div>
        }
      >
        <span className="text-deck-text">{snap.name}</span>
        {snap.archivedAt && (
          <span className="ml-2 rounded bg-deck-muted/20 px-1 py-0.5 text-[9px] uppercase tracking-wider text-deck-muted">
            已归档
          </span>
        )}
      </Header>
      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2">
        {actionError && (
          <div
            role="alert"
            className="mb-2 rounded border border-status-waiting/30 bg-status-waiting/10 px-2 py-1.5 text-[10px] text-status-waiting"
          >
            {actionError}
          </div>
        )}
        <MembersSection
          teamId={teamId}
          members={snap.members}
          onOpenSession={onOpenSession}
          canAddMember={snap.archivedAt === null}
          onMemberAdded={reloadAfterMemberAdded}
        />
        <LineageSection members={snap.members} onOpenSession={onOpenSession} />
        <PendingSection members={snap.members} onOpenSession={onOpenSession} />
        <EventsSection events={snap.recentEvents} />
        <TasksSection tasks={snap.tasks} />
        <MessagesSection messages={snap.recentMessages} />
      </div>
    </div>
  );
}
