import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  AskUserQuestionItem,
  AskUserQuestionRequest,
  DiffPayload,
  FileChangeRecord,
  PermissionRequest,
  SessionRecord,
} from '@shared/types';
import { ActivityFeed } from './ActivityFeed';
import { SummaryView } from './SummaryView';
import { DiffViewer } from './diff/DiffViewer';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_REQUESTS,
  useSessionStore,
} from '@renderer/stores/session-store';

type Tab = 'activity' | 'diff' | 'summary';

const EMPTY_EVENTS_FOR_TOAST: import('@shared/types').AgentEvent[] = [];

interface Props {
  session: SessionRecord;
  onClose: () => void;
}

export function SessionDetail({ session, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('activity');
  const [changes, setChanges] = useState<FileChangeRecord[] | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<number | null>(null);
  /** 最近被 SDK 自动取消的权限/提问，用于 toast 提示「不是你做的，是 SDK 取消的」。 */
  const [cancelToasts, setCancelToasts] = useState<{ id: string; text: string; ts: number }[]>([]);

  /** 留作选择器但目前未渲染 banner —— 活动流的 PermissionRow / AskRow 已统一接管。
   *  拿一下值用 void 标记 used，免得删 selector 还要清 EMPTY_REQUESTS / EMPTY_ASK_QUESTIONS。 */
  const pendingPermissions = useSessionStore(
    (s) => s.pendingPermissionsBySession.get(session.id) ?? EMPTY_REQUESTS,
  );
  const pendingAskQuestions = useSessionStore(
    (s) => s.pendingAskQuestionsBySession.get(session.id) ?? EMPTY_ASK_QUESTIONS,
  );
  void pendingPermissions;
  void pendingAskQuestions;
  const recent = useSessionStore(
    (s) => s.recentEventsBySession.get(session.id) ?? EMPTY_EVENTS_FOR_TOAST,
  );

  // 监听最近一条事件：如果是 SDK 主动取消的权限 / 提问，弹一个 5s toast，
  // 让用户知道 banner 上那条不是被自己点掉的。
  useEffect(() => {
    const e = recent[0];
    if (!e || e.kind !== 'waiting-for-user') return undefined;
    const p = (e.payload ?? {}) as { type?: string; requestId?: string };
    if (p.type !== 'permission-cancelled' && p.type !== 'ask-question-cancelled') {
      return undefined;
    }
    const id = `${e.ts}-${p.requestId ?? ''}`;
    const text =
      p.type === 'permission-cancelled'
        ? 'Claude 自动取消了一条权限请求'
        : 'Claude 自动取消了一条提问';
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

  useEffect(() => {
    if (tab === 'diff' && changes === null) {
      void window.api.listFileChanges(session.id).then((rows) => {
        const arr = rows as FileChangeRecord[];
        setChanges(arr);
        if (arr.length > 0) {
          // 默认选中最近改动的文件 + 该文件最新一次改动
          const latest = [...arr].sort((a, b) => b.ts - a.ts)[0];
          setSelectedFilePath(latest.filePath);
          setSelectedChangeId(latest.id);
        }
      });
    }
  }, [tab, changes, session.id]);

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

  const diffPayload: DiffPayload<string | null> | null = selectedChange
    ? {
        kind: selectedChange.kind,
        filePath: selectedChange.filePath,
        before: selectedChange.beforeBlob,
        after: selectedChange.afterBlob,
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
        <button
          type="button"
          onClick={onClose}
          className="ml-2 flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          title="返回列表"
        >
          ←
        </button>
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
        {(['activity', 'diff', 'summary'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-1 text-[11px] ${
              tab === t ? 'bg-white/10 text-deck-text' : 'text-deck-muted hover:bg-white/5'
            }`}
          >
            {t === 'activity' ? '活动' : t === 'diff' ? '改动' : '总结'}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2">
        {tab === 'activity' && (
          <ActivityFeed sessionId={session.id} agentId={session.agentId} isSdk={isSdk} />
        )}
        {tab === 'summary' && <SummaryView sessionId={session.id} />}
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
                  {diffPayload ? <DiffViewer payload={diffPayload} /> : null}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 底部输入区：SDK 会话可发消息；CLI 会话只显示提示 */}
      {isSdk ? (
        <ComposerSdk sessionId={session.id} agentId={session.agentId} cwd={session.cwd} />
      ) : (
        <CliFooter />
      )}
    </div>
  );
}

function SourceBadge({ isSdk }: { isSdk: boolean }): JSX.Element {
  return isSdk ? (
    <span className="rounded bg-status-working/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-status-working">
      内
    </span>
  ) : (
    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-deck-muted">
      外
    </span>
  );
}

/** 历史 banner 组件。当前由活动流接管，但 export 出来方便日后切回 banner 模式时直接复用。 */
export function PermissionRequests({
  sessionId,
  agentId,
  requests,
  isSdk,
}: {
  sessionId: string;
  agentId: string;
  requests: PermissionRequest[];
  isSdk: boolean;
}): JSX.Element {
  const resolve = useSessionStore((s) => s.resolvePermission);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 外部 CLI 会话：UI 上只能展示，不能响应（SDK 通道才有 canUseTool）
  const respond = async (
    req: PermissionRequest,
    decision: 'allow' | 'deny',
    alwaysAllow = false,
  ): Promise<void> => {
    if (!isSdk) return;
    setBusyId(req.requestId);
    try {
      await window.api.respondPermission(agentId, sessionId, req.requestId, {
        decision,
        message: decision === 'deny' ? '用户拒绝' : undefined,
        updatedInput: decision === 'allow' ? req.toolInput : undefined,
        updatedPermissions: alwaysAllow ? req.suggestions : undefined,
      });
      resolve(sessionId, req.requestId);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="shrink-0 border-b border-status-waiting/30 bg-status-waiting/10 px-3 py-2">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-status-waiting">
        ⚠️ 等待你的决定 · {requests.length}
      </div>
      <div className="flex flex-col gap-1.5">
        {requests.map((req) => (
          <div
            key={req.requestId}
            className="rounded-md border border-status-waiting/30 bg-deck-bg-strong/60 p-2"
          >
            <div className="text-[11px]">
              工具：<span className="font-mono">{req.toolName}</span>
            </div>
            {(() => {
              // Edit / Write / MultiEdit 这类有明确 file_path + old/new 的工具，
              // 直接用 DiffViewer 渲染 diff，比一坨 JSON 直观得多。
              const diff = toolInputToDiff(req.toolName, req.toolInput);
              return diff ? (
                <div className="mt-1 h-72 rounded border border-white/5">
                  <DiffViewer payload={diff} />
                </div>
              ) : (
                <pre className="mt-1 max-h-24 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
                  {JSON.stringify(req.toolInput, null, 2)}
                </pre>
              );
            })()}
            {isSdk ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                <button
                  type="button"
                  disabled={busyId === req.requestId}
                  onClick={() => void respond(req, 'allow')}
                  className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
                >
                  允许本次
                </button>
                {req.suggestions ? (
                  <button
                    type="button"
                    disabled={busyId === req.requestId}
                    onClick={() => void respond(req, 'allow', true)}
                    className="rounded bg-status-working/15 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/25 disabled:opacity-50"
                  >
                    始终允许
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busyId === req.requestId}
                  onClick={() => void respond(req, 'deny')}
                  className="rounded bg-status-waiting/30 px-2 py-0.5 text-[10px] text-status-waiting hover:bg-status-waiting/40 disabled:opacity-50"
                >
                  拒绝
                </button>
              </div>
            ) : (
              <div className="mt-1.5 text-[10px] text-deck-muted">
                外部 CLI 会话无法在此回应，请回到对应终端窗口操作
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ComposerSdk({
  sessionId,
  agentId,
  cwd,
}: {
  sessionId: string;
  agentId: string;
  cwd: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** "会话已断开" 时显示恢复按钮 —— sendMessage 抛 "not found" 等同于 SDK 通道已死。
   *  用 resume 选项重新拉起 CLI 子进程，CLI 加载历史 jsonl 续上对话。 */
  const [resumable, setResumable] = useState(false);
  const [resuming, setResuming] = useState(false);
  // SDK Query 自身持有运行时 permissionMode 但不暴露 getter，所以从 session 记录的
  // permission_mode 列读「用户上次主动选过的值」。这是持久化的（DB），切别的 detail
  // 再切回来 / 重启 dev / 恢复会话，下拉都能正确还原。CLI 通道这字段是 null → 默认。
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const permissionMode = (session?.permissionMode ?? 'default') as
    | 'default'
    | 'acceptEdits'
    | 'plan'
    | 'bypassPermissions';
  const [pmBusy, setPmBusy] = useState(false);
  const [pmError, setPmError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const t = text.trim();
    if (!t || busy) return;
    // 乐观清空，跟 resume 一致：让用户立刻感觉「发出去了」
    setText('');
    setBusy(true);
    setSendError(null);
    try {
      await window.api.sendAdapterMessage(agentId, sessionId, t);
      setResumable(false);
    } catch (err) {
      const msg = (err as Error).message;
      console.error('sendAdapterMessage failed', err);
      const dead = msg.includes('not found');
      setText(t);
      setSendError(dead ? '会话已断开（dev 重启 / SDK 流终止）。可以恢复后继续' : msg);
      setResumable(dead);
    } finally {
      setBusy(false);
    }
  };

  const resume = async (): Promise<void> => {
    const t = text.trim();
    if (!t) {
      setSendError('恢复会话需要先在输入框写一条新消息（SDK streaming 协议要求）');
      return;
    }
    // 乐观清空：让用户立刻看到「发出去了」，避免 SDK fallback 30s 等待期间以为没生效。
    // 失败时把文字退回输入框 + 显示错误。
    setText('');
    setResuming(true);
    setSendError(null);
    try {
      await window.api.createAdapterSession(agentId, {
        cwd,
        prompt: t,
        resume: sessionId,
      });
      setResumable(false);
    } catch (err) {
      setText(t);
      setSendError(`恢复失败：${(err as Error).message}`);
    } finally {
      setResuming(false);
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      await window.api.interruptAdapterSession(agentId, sessionId);
    } catch (err) {
      console.error('interrupt failed', err);
    }
  };

  const changeMode = async (next: typeof permissionMode): Promise<void> => {
    if (next === permissionMode || pmBusy) return;
    setPmBusy(true);
    setPmError(null);
    try {
      // IPC 主进程会同时调 SDK + 写 sessions.permission_mode + 推 session-upserted，
      // store 的 sessions Map 会自动更新，下拉值跟着 session 记录变。
      await window.api.setAdapterPermissionMode(agentId, sessionId, next);
    } catch (err) {
      setPmError((err as Error).message);
    } finally {
      setPmBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-deck-border px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-deck-muted">
        <span>权限</span>
        <select
          value={permissionMode}
          onChange={(e) => void changeMode(e.target.value as typeof permissionMode)}
          disabled={pmBusy}
          className="no-drag flex-1 min-w-0 rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
        >
          <option value="default">默认（每次询问）</option>
          <option value="acceptEdits">自动接受编辑</option>
          <option value="plan">Plan 模式（只规划）</option>
          <option value="bypassPermissions">完全免询问 ⚠️</option>
        </select>
      </div>
      {pmError && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          <span className="flex-1">⚠ 权限模式切换失败：{pmError}</span>
          <button
            type="button"
            onClick={() => setPmError(null)}
            className="text-status-waiting/70 hover:text-status-waiting"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {sendError && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          <span className="flex-1">⚠ {sendError}</span>
          {resumable && (
            <button
              type="button"
              disabled={resuming || !text.trim()}
              onClick={() => void resume()}
              className="rounded bg-status-working/30 px-1.5 py-0.5 text-status-working hover:bg-status-working/40 disabled:opacity-50"
              title={text.trim() ? '用 SDK resume 续上历史会话' : '先在输入框写一条新消息'}
            >
              {resuming ? '恢复中…' : '恢复会话'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setSendError(null);
              setResumable(false);
            }}
            className="text-status-waiting/70 hover:text-status-waiting"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送；Shift+Enter 换行（IME 拼写期间不拦，避免吞掉中文上屏的 Enter）
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              // 兼容旧浏览器：keyCode === 229 表示 IME 仍在拼写
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              if (text.trim() && !busy) void send();
            }
          }}
          placeholder="给 Claude 发消息…  (Enter 发送 / Shift+Enter 换行)"
          rows={2}
          className="flex-1 resize-none rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        />
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() || busy}
            className="rounded bg-status-working/30 px-2.5 py-1 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
          >
            {busy ? '发送中…' : '发送'}
          </button>
          <button
            type="button"
            onClick={() => void interrupt()}
            className="rounded bg-white/5 px-2.5 py-1 text-[10px] text-deck-muted hover:bg-white/10"
            title="中断当前任务"
          >
            中断
          </button>
        </div>
      </div>
    </div>
  );
}

function CliFooter(): JSX.Element {
  return (
    <div className="shrink-0 border-t border-deck-border bg-white/[0.02] px-3 py-2 text-[10px] leading-relaxed text-deck-muted">
      外部 CLI 会话 · 只读视图。请回到对应的终端窗口直接与 Claude 对话。
    </div>
  );
}

function ChangeTimeline({
  items,
  selectedId,
  onSelect,
}: {
  items: FileChangeRecord[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}): JSX.Element {
  return (
    <div className="shrink-0 max-h-32 overflow-y-auto scrollbar-deck rounded border border-deck-border/50 bg-white/[0.02] px-2 py-1.5">
      <ol className="relative ml-1.5 border-l border-white/10">
        {items.map((c, i) => {
          const isSelected = c.id === selectedId;
          const isLast = i === items.length - 1;
          return (
            <li key={c.id} className="relative pl-3 py-0.5">
              <span
                className={`absolute -left-[5px] top-1.5 inline-block h-2 w-2 rounded-full ring-2 ring-deck-bg ${
                  isSelected
                    ? 'bg-status-working'
                    : isLast
                    ? 'bg-deck-muted'
                    : 'bg-white/30'
                }`}
              />
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className={`flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-[10px] ${
                  isSelected
                    ? 'bg-white/10 text-deck-text'
                    : 'text-deck-muted hover:bg-white/5 hover:text-deck-text'
                }`}
                title={new Date(c.ts).toLocaleString('zh-CN', { hour12: false })}
              >
                <span className="font-mono tabular-nums">
                  {new Date(c.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span className="rounded bg-white/10 px-1 text-[9px] uppercase">{c.kind}</span>
                {isLast && (
                  <span className="ml-auto text-[9px] text-status-working/70">最新</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Claude 主动调用 AskUserQuestion 时弹出的面板。每个 question 一行，
 * options 用按钮（单选立即提交；multiSelect 用 checkbox + 提交按钮）。
 * 支持每题最后一个「其他」自由输入。
 */
/** 历史 banner 组件，与 PermissionRequests 同。当前由活动流接管。 */
export function AskUserQuestionPanel({
  sessionId,
  agentId,
  requests,
  isSdk,
}: {
  sessionId: string;
  agentId: string;
  requests: AskUserQuestionRequest[];
  isSdk: boolean;
}): JSX.Element {
  const resolve = useSessionStore((s) => s.resolveAskQuestion);

  return (
    <div className="shrink-0 border-b border-status-working/30 bg-status-working/[0.08] px-3 py-2">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-status-working">
        ❓ Claude 在询问你 · {requests.length}
      </div>
      <div className="flex flex-col gap-2">
        {requests.map((req) => (
          <AskQuestionForm
            key={req.requestId}
            request={req}
            isSdk={isSdk}
            onSubmit={async (answers) => {
              if (!isSdk) return;
              await window.api.respondAskUserQuestion(agentId, sessionId, req.requestId, {
                answers,
              });
              resolve(sessionId, req.requestId);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function AskQuestionForm({
  request,
  isSdk,
  onSubmit,
}: {
  request: AskUserQuestionRequest;
  isSdk: boolean;
  onSubmit: (
    answers: { question: string; selected: string[]; other?: string }[],
  ) => Promise<void>;
}): JSX.Element {
  // 每题用 Map 存「选中的 label 集合 + 其他文本」
  const [state, setState] = useState<Record<number, { selected: Set<string>; other: string }>>(
    () => {
      const init: Record<number, { selected: Set<string>; other: string }> = {};
      request.questions.forEach((_, i) => {
        init[i] = { selected: new Set(), other: '' };
      });
      return init;
    },
  );
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const answers = request.questions.map((q, i) => {
        const s = state[i] ?? { selected: new Set<string>(), other: '' };
        return {
          question: q.question,
          selected: [...s.selected],
          other: s.other.trim() || undefined,
        };
      });
      await onSubmit(answers);
    } finally {
      setBusy(false);
    }
  };

  // 单选 + 立即提交：option 点击后直接 onSubmit
  const pickSingle = async (qIdx: number, label: string): Promise<void> => {
    if (!isSdk || busy) return;
    setBusy(true);
    try {
      const answers = request.questions.map((q, i) => {
        if (i === qIdx) return { question: q.question, selected: [label] };
        const s = state[i] ?? { selected: new Set<string>(), other: '' };
        return {
          question: q.question,
          selected: [...s.selected],
          other: s.other.trim() || undefined,
        };
      });
      await onSubmit(answers);
    } finally {
      setBusy(false);
    }
  };

  const allMultiSelect = request.questions.every((q) => q.multiSelect);
  const anyMultiSelect = request.questions.some((q) => q.multiSelect);

  return (
    <div className="rounded-md border border-status-working/30 bg-deck-bg-strong/60 p-2">
      {request.questions.map((q, i) => (
        <QuestionRow
          key={i}
          q={q}
          state={state[i]}
          isSdk={isSdk}
          busy={busy}
          onToggle={(label) =>
            setState((prev) => {
              const cur = prev[i] ?? { selected: new Set<string>(), other: '' };
              const nextSelected = new Set(cur.selected);
              if (q.multiSelect) {
                if (nextSelected.has(label)) nextSelected.delete(label);
                else nextSelected.add(label);
              } else {
                nextSelected.clear();
                nextSelected.add(label);
              }
              return { ...prev, [i]: { ...cur, selected: nextSelected } };
            })
          }
          onChangeOther={(v) =>
            setState((prev) => ({
              ...prev,
              [i]: { ...(prev[i] ?? { selected: new Set<string>(), other: '' }), other: v },
            }))
          }
          onPickSingle={(label) => void pickSingle(i, label)}
        />
      ))}
      {(anyMultiSelect || !isSdk) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {!isSdk && (
            <span className="text-[10px] text-deck-muted">
              外部 CLI 会话无法在此回应，请回到对应终端窗口操作
            </span>
          )}
          {isSdk && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="ml-auto rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
            >
              {allMultiSelect ? '提交' : '提交所有答案'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionRow({
  q,
  state,
  isSdk,
  busy,
  onToggle,
  onChangeOther,
  onPickSingle,
}: {
  q: AskUserQuestionItem;
  state: { selected: Set<string>; other: string } | undefined;
  isSdk: boolean;
  busy: boolean;
  onToggle: (label: string) => void;
  onChangeOther: (v: string) => void;
  onPickSingle: (label: string) => void;
}): JSX.Element {
  const selected = state?.selected ?? new Set<string>();
  return (
    <div className="mb-2 last:mb-0">
      {q.header && (
        <div className="text-[10px] uppercase tracking-wider text-deck-muted/80">{q.header}</div>
      )}
      <div className="text-[11px] text-deck-text">{q.question}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {q.options.map((opt) => {
          const isSel = selected.has(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              disabled={!isSdk || busy}
              onClick={() => (q.multiSelect ? onToggle(opt.label) : onPickSingle(opt.label))}
              title={opt.description}
              className={`rounded border px-2 py-0.5 text-[10px] transition disabled:opacity-50 ${
                isSel
                  ? 'border-status-working/60 bg-status-working/30 text-status-working'
                  : 'border-deck-border bg-white/[0.04] text-deck-muted hover:bg-white/[0.08]'
              }`}
            >
              {q.multiSelect && <span className="mr-1">{isSel ? '☑' : '☐'}</span>}
              {opt.label}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        value={state?.other ?? ''}
        onChange={(e) => onChangeOther(e.target.value)}
        placeholder="其他（可选）"
        disabled={!isSdk || busy}
        className="mt-1.5 w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
      />
    </div>
  );
}

/**
 * 把 Edit / Write / MultiEdit 这类工具的 input 翻译成 DiffPayload，
 * 让权限请求面板能直接渲染成 diff（用户一眼看到改了啥），不需要看 JSON 猜。
 */
function toolInputToDiff(
  toolName: string,
  input: Record<string, unknown>,
): DiffPayload<string | null> | null {
  const i = input as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    edits?: { old_string: string; new_string: string }[];
  };
  if (!i.file_path) return null;
  const ts = Date.now();
  if (toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return {
      kind: 'text',
      filePath: i.file_path,
      before: i.old_string,
      after: i.new_string,
      ts,
    };
  }
  if (toolName === 'Write' && typeof i.content === 'string') {
    return { kind: 'text', filePath: i.file_path, before: null, after: i.content, ts };
  }
  if (toolName === 'MultiEdit' && Array.isArray(i.edits) && i.edits.length > 0) {
    return {
      kind: 'text',
      filePath: i.file_path,
      before: i.edits.map((e) => e.old_string).join('\n---\n'),
      after: i.edits.map((e) => e.new_string).join('\n---\n'),
      metadata: { source: 'MultiEdit', editCount: i.edits.length },
      ts,
    };
  }
  return null;
}
