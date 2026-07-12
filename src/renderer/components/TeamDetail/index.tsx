import { useCallback, useEffect, useState, type JSX } from 'react';
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

const logger = log.scope('renderer-team-detail');

/**
 * plan team-cohesion-fix-20260513 Phase C：TeamDetail 重写为「团队工作面板」。
 *
 * 6 个 section（顺序按用户「打开 team 想知道什么」次序排）：
 * 1. **Members** - 团队成员（lead + teammate + 已退出）
 * 2. **Lineage** - spawn 血缘树形（renderer 端从 sessions Map.spawnedBy 自拼）
 * 3. **Pending** - 团队成员的 pending（与 PendingTab 同源 store）
 * 4. **Events** - 跨成员事件流（IPC `findTeamEvents` 50 条）
 * 5. **Tasks** - team 内 tasks（IPC `taskRepo.list({teamId})`）
 * 6. **Messages** - cross-adapter messages（IPC 100 条 + 渲染前 30 条）
 *
 * 数据走单一 IPC `agent-deck-team:get-full(teamId)` 拉 4 sections snapshot
 * （members / events / tasks / messages），lineage / pending 由 renderer 自拼
 * （避免重复 SQL + 与 PendingTab 一致）。
 *
 * 增量刷新：subscribe `onAgentDeckTeamChanged` / `onAgentDeckMessageChanged` 触发整 refetch
 * （16ms debounce 在 main 端已做）；events / tasks / pending 实时性通过 store 自动 reactive
 * （sessions Map / pendingXBySession 变 → React 重渲染对应 section）。后续可加细粒度增量
 * patch 但当前 refetch 足够（snapshot 200ms 内拉完，UI 不闪）。
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

  useEffect(() => {
    let aborted = false;
    const fetch = (): void => {
      void window.api
        .getAgentDeckTeamFull(teamId)
        .then((row) => {
          if (aborted) return;
          if (!row) {
            setError('团队不存在或已删除');
          } else {
            setSnap(row);
            setError(null);
          }
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (aborted) return;
          setError(`加载失败：${(err as Error).message ?? String(err)}`);
          setLoading(false);
        });
    };
    fetch();
    // team / member / message 变化 → 整 refetch（main 端 16ms debounce 已限频）
    const offTeam = window.api.onAgentDeckTeamChanged(() => fetch());
    const offMsg = window.api.onAgentDeckMessageChanged(() => fetch());
    return () => {
      aborted = true;
      offTeam();
      offMsg();
    };
  }, [teamId]);

  const reloadAfterMemberAdded = useCallback(async (): Promise<void> => {
    const row = await window.api.getAgentDeckTeamFull(teamId);
    if (!row) {
      setError('团队不存在或已删除');
      return;
    }
    setSnap(row);
    setError(null);
    setLoading(false);
  }, [teamId]);

  // plan team-cohesion-fix-20260513 Phase F D7：批量 close 所有 teammate（lead 不动）。
  // 用户在 team 工作完成时一键清场，避免 N 个 teammate 散落在 SessionList 显示半天。
  const onShutdownAllTeammates = async (): Promise<void> => {
    if (!snap || actionBusy) return;
    const teammates = snap.members.filter((m) => m.role === 'teammate' && m.leftAt === null);
    if (teammates.length === 0) return;
    const ok = await window.api.confirmDialog({
      title: `关闭团队「${snap.name}」的所有协作者`,
      message: `将关闭 ${teammates.length} 个协作者会话，确定继续？`,
      detail: '负责人不会关闭。协作者关闭后会自动退出团队，但消息、事件和文件变更等历史记录都保留。关闭不可恢复，需要重新邀请才能再次协作。',
      okLabel: '全部关闭',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setActionBusy('shutdown');
    try {
      const result = await window.api.shutdownAllTeammates(teamId);
      if (result.failed.length > 0) {
        logger.warn(`[TeamDetail] shutdown failed for ${result.failed.length} teammate:`, result.failed);
        // 失败不弹错（confirmDialog 是 modal）；非阻塞 + console，下次 refetch 看到最新 snapshot
      }
    } catch (err) {
      logger.warn('[TeamDetail] shutdownAllTeammates threw:', err);
    } finally {
      setActionBusy(null);
    }
  };

  const onArchiveTeam = async (): Promise<void> => {
    if (!snap || actionBusy) return;
    if (snap.archivedAt !== null) return;
    const ok = await window.api.confirmDialog({
      title: `归档团队「${snap.name}」`,
      message: `确定要归档团队「${snap.name}」吗？`,
      detail: '归档后团队会从列表中隐藏；不删除团队、不关闭成员会话、不删除消息。可在归档列表中恢复。',
      okLabel: '归档',
      cancelLabel: '取消',
      destructive: false,
    });
    if (!ok) return;
    setActionBusy('archive');
    try {
      await window.api.archiveAgentDeckTeam(teamId);
    } catch (err) {
      logger.warn('[TeamDetail] archiveAgentDeckTeam threw:', err);
    } finally {
      setActionBusy(null);
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
                title={`关闭团队内全部 ${activeTeammateCount} 个协作者(负责人不动)`}
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
                title="归档团队(不关成员、不删数据)"
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
