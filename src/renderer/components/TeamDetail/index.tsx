import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { TeamDetailDto } from '@contracts/index';
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
import { useTeamDataSource, type TeamDataSource } from '../team-data-source';

const logger = log.scope('renderer-team-detail');

/**
 * Team workspace. One snapshot supplies members, events, tasks, and messages; lineage and
 * pending state stay reactive through the session store. Refreshes are team-scoped and
 * coalesced so an older team's response cannot replace the current view.
 */
interface Props {
  teamId: string;
  source?: TeamDataSource;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}

export function TeamDetail({ teamId, source, onBack, onOpenSession }: Props): JSX.Element {
  const localSource = useTeamDataSource(null, source === undefined);
  const activeSource = source ?? localSource;
  const [snap, setSnap] = useState<TeamDetailDto | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'shutdown' | 'archive' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const activeTeamIdRef = useRef(teamId);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const activeSourceRef = useRef(activeSource);
  const observedSourceRef = useRef(activeSource);
  activeTeamIdRef.current = teamId;
  activeSourceRef.current = activeSource;

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
        const result = await activeSourceRef.current.get(teamId);
        const row = result.team;
        if (disposed || generation !== refreshGenerationRef.current) return;
        if (!row) {
          setSnap(null);
          setError('团队不存在或已删除');
        } else {
          setSnap(row);
          setSnapshotRevision(result.revision);
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
    const off = activeSourceRef.current.subscribe(() => { void refresh(); }, teamId);
    return () => {
      disposed = true;
      pending = false;
      if (refreshGenerationRef.current === generation) refreshGenerationRef.current += 1;
      off();
      if (refreshRef.current === refresh) {
        refreshRef.current = async () => {};
      }
    };
  }, [activeSource.identity, teamId]);

  useEffect(() => {
    const previous = observedSourceRef.current;
    observedSourceRef.current = activeSource;
    if (previous.identity !== activeSource.identity) return;
    const timer = setTimeout(() => { void refreshRef.current(); }, 750);
    return () => clearTimeout(timer);
  }, [activeSource.revision]);

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
    const actionSourceIdentity = activeSource.identity;
    const actionIsCurrent = (): boolean => (
      actionGeneration === refreshGenerationRef.current
      && actionTeamId === activeTeamIdRef.current
      && activeSourceRef.current.identity === actionSourceIdentity
      && activeSourceRef.current.isUsable()
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
      const result = await activeSource.shutdownTeammates(actionTeamId, snapshotRevision);
      await refreshRef.current();
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
    const actionSourceIdentity = activeSource.identity;
    const actionIsCurrent = (): boolean => (
      actionGeneration === refreshGenerationRef.current
      && actionTeamId === activeTeamIdRef.current
      && activeSourceRef.current.identity === actionSourceIdentity
      && activeSourceRef.current.isUsable()
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
      await activeSource.archive(actionTeamId, snapshotRevision);
      await refreshRef.current();
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
        <div className="flex flex-col items-start gap-2 px-3 py-2 text-[11px] text-status-waiting/90">
          <div>{error ?? '未知错误'}</div>
          <button
            type="button"
            onClick={() => void refreshRef.current()}
            className="rounded bg-white/[0.06] px-2 py-1 text-deck-muted hover:text-deck-text"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  const activeTeammateCount = snap.members.filter(
    (m) => m.role === 'teammate' && m.leftAt === null,
  ).length;
  const sessions = new Map(snap.sessions.map((session) => [session.id, session]));

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
          members={snap.members}
          onOpenSession={onOpenSession}
          canAddMember={snap.archivedAt === null}
          onMemberAdded={reloadAfterMemberAdded}
          sessions={sessions}
          addMember={(sessionId, role) =>
            activeSource.addMember(teamId, sessionId, role, snapshotRevision).then(() => undefined)}
        />
        <LineageSection members={snap.members} sessions={sessions} onOpenSession={onOpenSession} />
        <PendingSection
          members={snap.members}
          pending={snap.pending}
          sessions={sessions}
          onOpenSession={onOpenSession}
        />
        <EventsSection events={snap.recentEvents} sessions={sessions} />
        <TasksSection tasks={snap.tasks} />
        <MessagesSection messages={snap.recentMessages} sessions={sessions} />
      </div>
    </div>
  );
}
