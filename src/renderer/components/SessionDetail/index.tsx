import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  AgentEvent,
  DiffPayload,
  FileFinalDiffResult,
  SessionRecord,
} from '@shared/types';
import { ActivityFeed } from '../activity-feed';
import { SummaryView } from '../SummaryView';
import { PermissionsView } from '../PermissionsView';
import { HandOffPreviewDialog } from '../HandOffPreviewDialog';
import { MessagesPanel } from './MessagesPanel';
import { SessionMetadataChips } from '../SessionMetadataChips';
import { SessionPinButton } from '../SessionPinButton';
import { ArrowLeftIcon, CloseIcon } from '../icons';
import {
  useSessionStore,
} from '@renderer/stores/session-store';
import { SourceBadge } from './SourceBadge';
import { ComposerSdk } from './ComposerSdk';
import { CliFooter } from './CliFooter';
import { DiffTab } from './DiffTab';
import { TasksPanel } from './TasksPanel';
import { SessionContextUsageChip } from '../SessionContextUsageChip';
import { decodeBlob, groupFileChanges } from './helpers';
import { useFileChanges } from './use-file-changes';
import { useFileChangeSelection } from './use-file-change-selection';
import { useFileChangePayload } from './use-file-change-payload';
import { useSessionGitBranch } from '@renderer/hooks/use-session-git-branches';

type Tab = 'activity' | 'tasks' | 'diff' | 'summary' | 'messages' | 'permissions';
type DiffMode = 'single' | 'final';
const EMPTY_EVENTS_FOR_TOAST: AgentEvent[] = [];

interface Props {
  session: SessionRecord;
  onClose: () => void;
}

export function SessionDetail({ session, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('activity');
  const [diffMode, setDiffMode] = useState<DiffMode>('single');
  const [finalDiff, setFinalDiff] = useState<FileFinalDiffResult | null>(null);
  const [finalDiffLoading, setFinalDiffLoading] = useState(false);
  const gitBranch = useSessionGitBranch(session);
  const fileChanges = useFileChanges({
    sessionId: session.id,
    enabled: tab === 'diff',
    workspaceKey: session.cwd,
  });
  const changes = fileChanges.changes;
  const selection = useFileChangeSelection({
    changes,
    sessionId: session.id,
    workspaceKey: session.cwd,
  });
  const selectedFilePath = selection.selectedFilePath;
  const selectedChangeId = selection.selectedChangeId;
  const selectedFileChange = useFileChangePayload({
    sessionId: session.id,
    selectedChangeId,
    workspaceKey: session.cwd,
  });
  const [handOffOpen, setHandOffOpen] = useState(false);
  /** 最近被 SDK 自动取消的权限/提问，用于 toast 提示「不是你做的，是 SDK 取消的」。 */
  const [cancelToasts, setCancelToasts] = useState<{ id: string; text: string; ts: number }[]>([]);
  // Toast timer 按 id 独立管理，后续事件刷新不会提前取消自动关闭。
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissToast = (id: string): void => {
    setCancelToasts((prev) => prev.filter((t) => t.id !== id));
    const tm = toastTimersRef.current.get(id);
    if (tm) {
      clearTimeout(tm);
      toastTimersRef.current.delete(id);
    }
  };
  // 卸载时清掉所有挂起的 toast timer（防 setState on unmounted）。
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const tm of timers.values()) clearTimeout(tm);
      timers.clear();
    };
  }, []);

  const recent = useSessionStore(
    (s) => s.recentEventsBySession.get(session.id) ?? EMPTY_EVENTS_FOR_TOAST,
  );

  // SDK 自动取消权限、提问或计划批准时显示 5 秒提示。
  useEffect(() => {
    const e = recent[0];
    if (!e || e.kind !== 'waiting-for-user') return;
    const p = (e.payload ?? {}) as { type?: string; requestId?: string };
    if (
      p.type !== 'permission-cancelled' &&
      p.type !== 'ask-question-cancelled' &&
      p.type !== 'exit-plan-cancelled'
    ) {
      return;
    }
    const id = `${e.ts}-${p.requestId ?? ''}`;
    // 已有该 toast（含已注册 timer）→ 不重复加、不重设 timer。
    if (toastTimersRef.current.has(id)) return;
    const kindLabel =
      p.type === 'permission-cancelled'
        ? '权限请求'
        : p.type === 'ask-question-cancelled'
          ? '提问'
          : '计划批准请求';
    const text = `已取消一条${kindLabel}`;
    setCancelToasts((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, text, ts: e.ts }]));
    const timer = setTimeout(() => {
      setCancelToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimersRef.current.delete(id);
    }, 5000);
    toastTimersRef.current.set(id, timer);
  }, [recent]);

  useEffect(() => {
    setTab('activity');
    setDiffMode('single');
    setFinalDiff(null);
    setFinalDiffLoading(false);
    // 组件切换会话时不会 remount，因此同步清空上一会话的提示和 timer。
    setCancelToasts([]);
    for (const tm of toastTimersRef.current.values()) clearTimeout(tm);
    toastTimersRef.current.clear();
  }, [session.id]);

  useEffect(() => {
    setDiffMode('single');
    setFinalDiff(null);
    setFinalDiffLoading(false);
  }, [session.id, session.cwd]);

  // 按文件分组：组内升序（旧→新）+ 文件按最近改动倒序，同毫秒带 id tiebreaker（详 groupFileChanges）。
  const fileGroups = useMemo(() => (changes ? groupFileChanges(changes) : []), [changes]);

  const selectedGroup = useMemo(
    () => fileGroups.find((g) => g.filePath === selectedFilePath) ?? null,
    [fileGroups, selectedFilePath],
  );

  const selectedChange =
    selectedFileChange.selectedPayload?.id === selectedChangeId
      ? selectedFileChange.selectedPayload
      : null;
  const selectedGroupLastId = selectedGroup?.lastId ?? null;

  useEffect(() => {
    if (tab !== 'diff' || diffMode !== 'final' || !selectedFilePath) return;
    let disposed = false;
    setFinalDiffLoading(true);
    setFinalDiff(null);
    void window.api
      .getFileFinalDiff(session.id, selectedFilePath)
      .then((r) => {
        if (disposed) return;
        setFinalDiff(r);
      })
      .catch(() => {
        if (disposed) return;
        setFinalDiff({
          ok: false,
          filePath: selectedFilePath,
          diff: null,
          source: 'recorded-snapshot',
          reason: 'snapshot_unavailable',
          message: '无法加载最终 diff。',
        });
      })
      .finally(() => {
        if (!disposed) setFinalDiffLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [tab, diffMode, session.id, selectedFilePath, selectedGroupLastId]);

  const diffPayload: DiffPayload | null = selectedChange
    ? {
        kind: selectedChange.kind,
        filePath: selectedChange.filePath,
        before: decodeBlob(
          selectedChange.kind,
          selectedChange.beforeSnapshot ?? selectedChange.beforeBlob,
        ),
        after: decodeBlob(
          selectedChange.kind,
          selectedChange.afterSnapshot ?? selectedChange.afterBlob,
        ),
        metadata: selectedChange.metadata,
        toolCallId: selectedChange.toolCallId ?? undefined,
        ts: selectedChange.ts,
      }
    : null;
  const finalDiffPayload: DiffPayload | null =
    finalDiff?.ok && finalDiff.diff
      ? {
          kind: 'text',
          filePath: finalDiff.filePath,
          before: null,
          after: null,
          metadata: { source: finalDiff.source, diff: finalDiff.diff },
          ts: selectedGroup?.lastTs ?? 0,
        }
      : null;

  const isSdk = session.source === 'sdk';
  const turnBusy = session.activity === 'working';
  const canSteerTurn = session.agentId === 'codex-cli' || session.agentId === 'grok-build';
  const canSteerTurnAttachments = session.agentId === 'grok-build';
  const canPin =
    session.archivedAt === null &&
    (session.lifecycle === 'active' || session.lifecycle === 'dormant');
  const selectFileGroup = (group: NonNullable<typeof selectedGroup>): void => {
    selection.selectFile(group.filePath, group.items[group.items.length - 1].id);
    setFinalDiff(null);
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <SourceBadge isSdk={isSdk} />
            <div className="truncate text-[12px] font-medium">{session.title}</div>
          </div>
          <div className="truncate text-[10px] text-deck-muted">{session.cwd}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <SessionMetadataChips session={session} branch={gitBranch} compact />
            <SessionContextUsageChip session={session} />
          </div>
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {canPin && <SessionPinButton key={session.id} session={session} />}
          <button
            type="button"
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            title="返回列表"
            aria-label="返回列表"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {cancelToasts.length > 0 && (
        <div className="shrink-0 border-b border-deck-border/40 bg-white/[0.03] px-3 py-1.5">
          <div className="flex flex-col gap-1">
            {cancelToasts.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-1.5 text-[10px] text-deck-muted"
              >
                <span>⚪</span>
                <span className="flex-1">{t.text}</span>
                <button
                  type="button"
                  onClick={() => dismissToast(t.id)}
                  className="text-deck-muted/60 hover:text-deck-text"
                  aria-label="关闭"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <nav className="flex shrink-0 gap-1 border-b border-deck-border/60 px-2 py-1">
        {(['activity', 'tasks', 'diff', 'summary', 'messages', 'permissions'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-1 text-[11px] ${
              tab === t ? 'bg-white/10 text-deck-text' : 'text-deck-muted hover:bg-white/5'
            }`}
          >
            {t === 'activity'
              ? '活动'
              : t === 'tasks'
                ? '任务'
                : t === 'diff'
                  ? '改动'
                  : t === 'summary'
                    ? '总结'
                    : t === 'messages'
                      ? '跨会话'
                      : '权限'}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-deck px-3 py-2">
        {tab === 'activity' && (
          <ActivityFeed sessionId={session.id} agentId={session.agentId} isSdk={isSdk} />
        )}
        {tab === 'tasks' && <TasksPanel sessionId={session.id} />}
        {tab === 'summary' && <SummaryView sessionId={session.id} />}
        {tab === 'messages' && <MessagesPanel sessionId={session.id} />}
        {tab === 'permissions' && (
          <PermissionsView
            cwd={session.cwd}
            sessionId={session.id}
            agentId={session.agentId}
            sessionMode={session.sessionMode}
          />
        )}
        {tab === 'diff' && (
          <DiffTab
            sessionId={session.id}
            changes={changes}
            diffError={fileChanges.error}
            hasMore={fileChanges.hasMore}
            loadedCount={fileChanges.loadedCount}
            loadingMore={fileChanges.loadingMore}
            lastLoadSummary={fileChanges.lastLoadSummary}
            hasNewerChanges={selection.hasNewerChanges}
            payloadLoading={selectedFileChange.payloadLoading}
            payloadError={selectedFileChange.payloadError}
            fileGroups={fileGroups}
            selectedFilePath={selectedFilePath}
            selectedGroup={selectedGroup}
            selectedChangeId={selectedChangeId}
            diffMode={diffMode}
            finalDiffLoading={finalDiffLoading}
            finalDiff={finalDiff}
            diffPayload={diffPayload}
            finalDiffPayload={finalDiffPayload}
            onSelectFile={selectFileGroup}
            onSelectChange={(id) => {
              selection.selectChange(id);
              setDiffMode('single');
            }}
            onDiffModeChange={setDiffMode}
            onLoadMore={() => void fileChanges.loadMore()}
            onFollowLatest={() => {
              selection.followLatest();
              setDiffMode('single');
              setFinalDiff(null);
            }}
            onRetry={() => void fileChanges.retry()}
          />
        )}
      </div>

      {/* SDK 会话提供输入与接力操作；CLI 会话只显示提示。 */}
      {isSdk ? (
        <ComposerSdk
          session={session}
          onHandOff={() => setHandOffOpen(true)}
          turnBusy={turnBusy}
          canSteerTurn={canSteerTurn}
          canSteerTurnAttachments={canSteerTurnAttachments}
        />
      ) : (
        <CliFooter agentId={session.agentId} />
      )}

      {/* 接力成功后主进程负责切换会话，这里只管理预览框。 */}
      <HandOffPreviewDialog
        open={handOffOpen}
        session={session}
        onClose={() => setHandOffOpen(false)}
      />
    </div>
  );
}
