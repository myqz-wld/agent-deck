import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  AgentEvent,
  DiffPayload,
  FileFinalDiffResult,
  FileChangeRecord,
  SessionRecord,
} from '@shared/types';
import { ActivityFeed } from '../activity-feed';
import { SummaryView } from '../SummaryView';
import { PermissionsView } from '../PermissionsView';
import { HandOffPreviewDialog } from '../HandOffPreviewDialog';
import { MessagesPanel } from './MessagesPanel';
import { SessionMetadataChips } from '../SessionMetadataChips';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_EXIT_PLAN_MODES,
  EMPTY_REQUESTS,
  useSessionStore,
} from '@renderer/stores/session-store';
import { SourceBadge } from './SourceBadge';
import { ComposerSdk } from './ComposerSdk';
import { CliFooter } from './CliFooter';
import { DiffTab } from './DiffTab';
import { TasksPanel } from './TasksPanel';
import { decodeBlob, groupFileChanges, pickLatestChange } from './helpers';

type Tab = 'activity' | 'tasks' | 'diff' | 'summary' | 'messages' | 'permissions';
type DiffMode = 'single' | 'final';
const GIT_BRANCH_REFRESH_MS = 10_000;

const EMPTY_EVENTS_FOR_TOAST: AgentEvent[] = [];

interface Props {
  session: SessionRecord;
  onClose: () => void;
}

export function SessionDetail({ session, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('activity');
  const [changes, setChanges] = useState<FileChangeRecord[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<number | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>('single');
  const [finalDiff, setFinalDiff] = useState<FileFinalDiffResult | null>(null);
  const [finalDiffLoading, setFinalDiffLoading] = useState(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  /** K3 hand-off preview dialog 开关（plan mcp-bug-and-feature-batch-20260513 Phase 4c）。 */
  const [handOffOpen, setHandOffOpen] = useState(false);
  /** 最近被 SDK 自动取消的权限/提问，用于 toast 提示「不是你做的，是 SDK 取消的」。 */
  const [cancelToasts, setCancelToasts] = useState<{ id: string; text: string; ts: number }[]>([]);
  // deep-review H3 MED：auto-dismiss timer 用独立 ref registry，**不绑 [recent] effect cleanup**。
  // 旧实现 timer 在 [recent] effect 内 setTimeout + cleanup clearTimeout → 下一条非 cancel 事件到达
  // 时 React 先跑旧 cleanup 杀掉 timer、新 effect 看非 cancel 直接 return 不补设 timer → toast 永不
  // auto-dismiss（活跃会话取消后必有后续活动，必踩）。改为按 toast id 存 timer，添加时设、移除/卸载时清。
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

  /** 留作选择器但目前未渲染 banner —— 活动流的 PermissionRow / AskRow / ExitPlanRow 已统一接管。
   *  拿一下值用 void 标记 used，免得删 selector 还要清 EMPTY_REQUESTS / EMPTY_ASK_QUESTIONS / EMPTY_EXIT_PLAN_MODES。 */
  const pendingPermissions = useSessionStore(
    (s) => s.pendingPermissionsBySession.get(session.id) ?? EMPTY_REQUESTS,
  );
  const pendingAskQuestions = useSessionStore(
    (s) => s.pendingAskQuestionsBySession.get(session.id) ?? EMPTY_ASK_QUESTIONS,
  );
  const pendingExitPlanModes = useSessionStore(
    (s) => s.pendingExitPlanModesBySession.get(session.id) ?? EMPTY_EXIT_PLAN_MODES,
  );
  void pendingPermissions;
  void pendingAskQuestions;
  void pendingExitPlanModes;
  const recent = useSessionStore(
    (s) => s.recentEventsBySession.get(session.id) ?? EMPTY_EVENTS_FOR_TOAST,
  );

  // 监听最近一条事件：如果是 SDK 主动取消的权限 / 提问 / 计划批准，弹一个 5s toast，
  // 让用户知道 banner 上那条不是被自己点掉的。
  // deep-review H3 MED：timer 放 toastTimersRef（不绑本 effect cleanup），避免下一条事件 cleanup
  // 杀掉 auto-dismiss timer。本 effect 只负责「检测 cancel 事件 → 加 toast + 注册 timer」。
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
    setChanges(null);
    setDiffError(null);
    setSelectedFilePath(null);
    setSelectedChangeId(null);
    setDiffMode('single');
    setFinalDiff(null);
    setFinalDiffLoading(false);
    // deep-review H3 MED：SessionDetail 无 key prop（App.tsx）→ 切会话不 remount，cancelToasts
    // useState 跨会话存活；切会话时 B 的 recent[0] 非 cancel 不会触发清理 → A 的 toast 串到 B。
    // 这里 reset 时一并清空 toast + 其 timer。
    setCancelToasts([]);
    for (const tm of toastTimersRef.current.values()) clearTimeout(tm);
    toastTimersRef.current.clear();
  }, [session.id]);

  useEffect(() => {
    let disposed = false;
    let requestSeq = 0;
    const refreshGitBranch = (): void => {
      const seq = ++requestSeq;
      void window.api
        .getSessionGitBranch(session.id)
        .then((branch) => {
          if (!disposed && seq === requestSeq) setGitBranch(branch);
        })
        .catch(() => {
          if (!disposed && seq === requestSeq) setGitBranch(null);
        });
    };

    setGitBranch(null);
    refreshGitBranch();
    const timer = window.setInterval(refreshGitBranch, GIT_BRANCH_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [session.id]);

  /** 加载并订阅 file_changes：
   * - tab 切到 'diff' 且未加载 → 首次拉
   * - 已加载状态下监听 agent-event 'file-changed'，300ms 节流后重拉（合并 MultiEdit 拆出的 N 条事件）
   * - sequence counter 防过期 IPC 覆盖新结果；disposed flag 防卸载/换会话后 setState
   * - 重新选中策略：原选中 filePath / changeId 仍在新数据里 → 保留；否则 fallback 到最新一条
   *
   * REVIEW_2 修：原本仅在 changes===null 时拉一次，期间产生的新 file-changed 不会刷新；
   *           且切会话时旧 IPC 返回会污染新会话列表。融合 Claude A 节流 + Codex B sequence。
   *
   * deep-review H3 LOW：effect deps 去掉 hasLoaded（改用 changesLoadedRef）。旧 hasLoaded 入 deps →
   * 首次 sync setChanges 后 false→true 触发 effect 重订阅，cleanup `clearTimeout(timer)` 会杀掉 sync
   * 在途期间 file-changed 设的 300ms 节流 timer → 那条刷新被吞直到下条 file-changed。去掉 hasLoaded
   * dep 让订阅在「首加载」前后稳定，不重订阅不杀 timer。
   */
  const changesLoadedRef = useRef(false);
  useEffect(() => {
    changesLoadedRef.current = changes !== null;
  });
  useEffect(() => {
    if (tab !== 'diff' && !changesLoadedRef.current) return;
    let disposed = false;
    let req = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sync = (): void => {
      const cur = ++req;
      void window.api
        .listFileChanges(session.id)
        .then((rows) => {
          if (disposed || cur !== req) return;
          const arr = rows as FileChangeRecord[];
          // deep-review H3 LOW：同毫秒同文件改动 latest 选取带 id tiebreaker（pickLatestChange 与
          // groupFileChanges 同 tiebreaker，DB 端是 ts DESC, id DESC，新 id 在前）。
          const latest = pickLatestChange(arr);
          setChanges(arr);
          setDiffError(null);
          setSelectedFilePath((p) =>
            p && arr.some((c) => c.filePath === p) ? p : latest?.filePath ?? null,
          );
          setSelectedChangeId((p) =>
            p !== null && arr.some((c) => c.id === p) ? p : latest?.id ?? null,
          );
        })
        .catch((err: unknown) => {
          // deep-review H3 MED：无 catch 时 IPC reject 冒泡 main.tsx unhandledrejection → 全屏 fatal。
          // 接住 → diffError。渲染处（changes===null 才整屏 error，有数据时 inline strip 保留 stale）
          // 与 MessagesPanel `error && messages.length===0` 守门对齐（H3 R2 LOW 修正）。
          if (disposed || cur !== req) return;
          setDiffError(err instanceof Error ? err.message : String(err));
        });
    };
    if (tab === 'diff' && changes === null) sync();
    const off = window.api.onAgentEvent((e) => {
      if (e.sessionId !== session.id || e.kind !== 'file-changed') return;
      if (timer != null) return;
      timer = setTimeout(() => {
        timer = null;
        sync();
      }, 300);
    });
    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
      off();
    };
    // changes 故意不入 deps（只用首次 sync 的 changes===null 判定 + changesLoadedRef 读最新），
    // 防 changes 每次刷新都重订阅；仅 tab/session.id 变才重订阅。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, session.id]);

  // 按文件分组：组内升序（旧→新）+ 文件按最近改动倒序，同毫秒带 id tiebreaker（详 groupFileChanges）。
  const fileGroups = useMemo(() => (changes ? groupFileChanges(changes) : []), [changes]);

  const selectedGroup = useMemo(
    () => fileGroups.find((g) => g.filePath === selectedFilePath) ?? null,
    [fileGroups, selectedFilePath],
  );

  const selectedChange = useMemo(
    () => changes?.find((c) => c.id === selectedChangeId) ?? null,
    [changes, selectedChangeId],
  );
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
      .catch((err: unknown) => {
        if (disposed) return;
        setFinalDiff({
          ok: false,
          filePath: selectedFilePath,
          diff: null,
          source: 'recorded-snapshot',
          reason: 'snapshot_unavailable',
          message: err instanceof Error ? err.message : String(err),
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
  const canSteerTurn = session.agentId === 'codex-cli';
  const selectFileGroup = (group: NonNullable<typeof selectedGroup>): void => {
    setSelectedFilePath(group.filePath);
    setSelectedChangeId(group.items[group.items.length - 1].id);
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
          <div className="mt-1">
            <SessionMetadataChips session={session} branch={gitBranch} compact />
          </div>
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            title="返回列表"
          >
            ←
          </button>
        </div>
      </header>

      {/* 顶部 banner 已废弃：权限请求 / AskUserQuestion 全部由活动流的 PermissionRow / AskRow 内嵌渲染并响应。
         留空对照位避免日后重复加 banner —— 真要恢复 banner 请同时在活动流里跳过同 requestId。 */}

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
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 权限请求 banner 同样删掉，统一由活动流接管。 */}

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
            agentId={session.agentId}
            codexSandbox={session.codexSandbox}
          />
        )}
        {tab === 'diff' && (
          <DiffTab
            sessionId={session.id}
            changes={changes}
            diffError={diffError}
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
              setSelectedChangeId(id);
              setDiffMode('single');
            }}
            onDiffModeChange={setDiffMode}
          />
        )}
      </div>

      {/* 底部输入区：SDK 会话可发消息；CLI 会话只显示提示。
          CHANGELOG_94: 「📤 接力到新会话」按钮从 header 右上角挪到 ComposerSdk 右下角
          （中断按钮左侧），通过 onHandOff prop 触发 setHandOffOpen(true)。 */}
      {isSdk ? (
        <ComposerSdk
          session={session}
          onHandOff={() => setHandOffOpen(true)}
          turnBusy={turnBusy}
          canSteerTurn={canSteerTurn}
        />
      ) : (
        <CliFooter />
      )}

      {/* K3 hand-off preview dialog（plan mcp-bug-and-feature-batch-20260513 Phase 4c）。
          spawn 成功后 main 端 emit session-focus-request 让 App 自动切到新 session detail，
          所以这里 onClose 只关闭 modal 不需 props 传 newSid。 */}
      <HandOffPreviewDialog
        open={handOffOpen}
        session={session}
        onClose={() => setHandOffOpen(false)}
      />
    </div>
  );
}
