import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  AgentEvent,
  DiffPayload,
  FileChangeRecord,
  SessionRecord,
} from '@shared/types';
import { ActivityFeed } from '../activity-feed';
import { SummaryView } from '../SummaryView';
import { DiffViewer } from '../diff/DiffViewer';
import { PermissionsView } from '../PermissionsView';
import { HandOffPreviewDialog } from '../HandOffPreviewDialog';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_EXIT_PLAN_MODES,
  EMPTY_REQUESTS,
  useSessionStore,
} from '@renderer/stores/session-store';
import { SourceBadge } from './SourceBadge';
import { ComposerSdk } from './ComposerSdk';
import { CliFooter } from './CliFooter';
import { ChangeTimeline } from './ChangeTimeline';
import { decodeBlob } from './helpers';

type Tab = 'activity' | 'diff' | 'summary' | 'permissions';

const EMPTY_EVENTS_FOR_TOAST: AgentEvent[] = [];

interface Props {
  session: SessionRecord;
  onClose: () => void;
}

export function SessionDetail({ session, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('activity');
  const [changes, setChanges] = useState<FileChangeRecord[] | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<number | null>(null);
  /** K3 hand-off preview dialog 开关（plan mcp-bug-and-feature-batch-20260513 Phase 4c）。 */
  const [handOffOpen, setHandOffOpen] = useState(false);
  /** 最近被 SDK 自动取消的权限/提问，用于 toast 提示「不是你做的，是 SDK 取消的」。 */
  const [cancelToasts, setCancelToasts] = useState<{ id: string; text: string; ts: number }[]>([]);

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
  useEffect(() => {
    const e = recent[0];
    if (!e || e.kind !== 'waiting-for-user') return undefined;
    const p = (e.payload ?? {}) as { type?: string; requestId?: string };
    if (
      p.type !== 'permission-cancelled' &&
      p.type !== 'ask-question-cancelled' &&
      p.type !== 'exit-plan-cancelled'
    ) {
      return undefined;
    }
    const id = `${e.ts}-${p.requestId ?? ''}`;
    const text =
      p.type === 'permission-cancelled'
        ? 'Claude 自动取消了一条权限请求'
        : p.type === 'ask-question-cancelled'
          ? 'Claude 自动取消了一条提问'
          : 'Claude 自动取消了一次计划批准请求';
    setCancelToasts((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [...prev, { id, text, ts: e.ts }];
    });
    const timer = setTimeout(() => {
      setCancelToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
    return () => clearTimeout(timer);
  }, [recent]);

  useEffect(() => {
    setTab('activity');
    setChanges(null);
    setSelectedFilePath(null);
    setSelectedChangeId(null);
  }, [session.id]);

  /** 加载并订阅 file_changes：
   * - tab 切到 'diff' 且未加载 → 首次拉
   * - 已加载状态下监听 agent-event 'file-changed'，300ms 节流后重拉（合并 MultiEdit 拆出的 N 条事件）
   * - sequence counter 防过期 IPC 覆盖新结果；disposed flag 防卸载/换会话后 setState
   * - 重新选中策略：原选中 filePath / changeId 仍在新数据里 → 保留；否则 fallback 到最新一条
   *
   * REVIEW_2 修：原本仅在 changes===null 时拉一次，期间产生的新 file-changed 不会刷新；
   *           且切会话时旧 IPC 返回会污染新会话列表。融合 Claude A 节流 + Codex B sequence。
   */
  const hasLoaded = changes !== null;
  useEffect(() => {
    if (tab !== 'diff' && !hasLoaded) return;
    let disposed = false;
    let req = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sync = (): void => {
      const cur = ++req;
      void window.api.listFileChanges(session.id).then((rows) => {
        if (disposed || cur !== req) return;
        const arr = rows as FileChangeRecord[];
        const latest = arr.length > 0 ? [...arr].sort((a, b) => b.ts - a.ts)[0] : null;
        setChanges(arr);
        setSelectedFilePath((p) =>
          p && arr.some((c) => c.filePath === p) ? p : latest?.filePath ?? null,
        );
        setSelectedChangeId((p) =>
          p !== null && arr.some((c) => c.id === p) ? p : latest?.id ?? null,
        );
      });
    };
    if (tab === 'diff' && !hasLoaded) sync();
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
  }, [tab, hasLoaded, session.id]);

  // 按文件分组：每组内按时间升序（时间线从上到下：旧 → 新）；
  // 文件按最近一次改动时间倒序排列，让最近活跃的文件排前面。
  const fileGroups = useMemo(() => {
    if (!changes) return [];
    const map = new Map<string, FileChangeRecord[]>();
    for (const c of changes) {
      const arr = map.get(c.filePath) ?? [];
      arr.push(c);
      map.set(c.filePath, arr);
    }
    return [...map.entries()]
      .map(([filePath, items]) => {
        const sorted = items.sort((a, b) => a.ts - b.ts);
        return {
          filePath,
          items: sorted,
          lastTs: sorted[sorted.length - 1].ts,
        };
      })
      .sort((a, b) => b.lastTs - a.lastTs);
  }, [changes]);

  const selectedGroup = useMemo(
    () => fileGroups.find((g) => g.filePath === selectedFilePath) ?? null,
    [fileGroups, selectedFilePath],
  );

  const selectedChange = useMemo(
    () => changes?.find((c) => c.id === selectedChangeId) ?? null,
    [changes, selectedChangeId],
  );

  const diffPayload: DiffPayload | null = selectedChange
    ? {
        kind: selectedChange.kind,
        filePath: selectedChange.filePath,
        before: decodeBlob(selectedChange.kind, selectedChange.beforeBlob),
        after: decodeBlob(selectedChange.kind, selectedChange.afterBlob),
        metadata: selectedChange.metadata,
        toolCallId: selectedChange.toolCallId ?? undefined,
        ts: selectedChange.ts,
      }
    : null;

  const isSdk = session.source === 'sdk';

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <SourceBadge isSdk={isSdk} />
            <div className="truncate text-[12px] font-medium">{session.title}</div>
          </div>
          <div className="truncate text-[10px] text-deck-muted">{session.cwd}</div>
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {isSdk && (
            <button
              type="button"
              onClick={() => setHandOffOpen(true)}
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
              title="📤 接力到新会话：LLM 总结当前会话历史 → 起新 session（cwd / agent / 权限模式沿用）+ 自动归档原会话"
            >
              📤
            </button>
          )}
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
                  onClick={() =>
                    setCancelToasts((prev) => prev.filter((x) => x.id !== t.id))
                  }
                  className="text-deck-muted/60 hover:text-deck-text"
                  aria-label="dismiss"
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
        {(['activity', 'diff', 'summary', 'permissions'] as Tab[]).map((t) => (
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
              : t === 'diff'
                ? '改动'
                : t === 'summary'
                  ? '总结'
                  : '权限'}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2">
        {tab === 'activity' && (
          <ActivityFeed sessionId={session.id} agentId={session.agentId} isSdk={isSdk} />
        )}
        {tab === 'summary' && <SummaryView sessionId={session.id} />}
        {tab === 'permissions' && <PermissionsView cwd={session.cwd} />}
        {tab === 'diff' && (
          <div className="flex h-full flex-col gap-2">
            {changes === null ? (
              <div className="text-[11px] text-deck-muted">加载中…</div>
            ) : changes.length === 0 ? (
              <div className="text-[11px] text-deck-muted">本会话暂无文件改动</div>
            ) : (
              <>
                {/* 文件分组：每个文件一个按钮，右上角小角标显示改动次数 */}
                <div className="flex shrink-0 flex-wrap gap-1">
                  {fileGroups.map((g) => (
                    <button
                      key={g.filePath}
                      type="button"
                      onClick={() => {
                        setSelectedFilePath(g.filePath);
                        // 切到该文件最新一次改动
                        setSelectedChangeId(g.items[g.items.length - 1].id);
                      }}
                      className={`relative max-w-[160px] truncate rounded px-2 py-1 text-[10px] font-mono ${
                        selectedFilePath === g.filePath
                          ? 'bg-white/15 text-deck-text'
                          : 'bg-white/[0.03] text-deck-muted hover:bg-white/[0.08]'
                      }`}
                      title={`${g.filePath}（${g.items.length} 次改动）`}
                    >
                      {g.filePath.split('/').pop()}
                      {g.items.length > 1 && (
                        <span className="ml-1 rounded bg-white/15 px-1 text-[9px] text-deck-text/80">
                          {g.items.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* 选中文件的时间线：每行一次改动；点击切换显示对应 diff */}
                {selectedGroup && selectedGroup.items.length > 1 && (
                  <ChangeTimeline
                    items={selectedGroup.items}
                    selectedId={selectedChangeId}
                    onSelect={setSelectedChangeId}
                  />
                )}

                <div className="min-h-0 flex-1">
                  {diffPayload ? <DiffViewer payload={diffPayload} sessionId={session.id} /> : null}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 底部输入区：SDK 会话可发消息；CLI 会话只显示提示 */}
      {isSdk ? (
        <ComposerSdk sessionId={session.id} agentId={session.agentId} />
      ) : (
        <CliFooter />
      )}

      {/* K3 hand-off preview dialog（plan mcp-bug-and-feature-batch-20260513 Phase 4c）。
          spawn 成功后 main 端 emit session-focus-request 让 App 自动切到新 session detail，
          所以这里 onClose 只关闭 modal 不需 props 传 newSid。 */}
      <HandOffPreviewDialog
        open={handOffOpen}
        sessionId={session.id}
        onClose={() => setHandOffOpen(false)}
      />
    </div>
  );
}
