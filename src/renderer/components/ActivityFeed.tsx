import { useEffect, useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  DiffPayload,
  ExitPlanModeRequest,
  ImageSource,
  PermissionRequest,
} from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_EXIT_PLAN_MODES,
  EMPTY_REQUESTS,
  useSessionStore,
} from '@renderer/stores/session-store';
import { DiffViewer } from './diff/DiffViewer';
import { MarkdownText } from './MarkdownText';

/**
 * 消息气泡渲染模式。CHANGELOG_34 把 MD/TXT 切换从「全局共享」改成「每条独立」之后，
 * localStorage 里那个 `agent-deck:message-render-mode` 键再也没人写了
 * （永远只能读到 'plaintext' 默认值），CHANGELOG_35 顺手把整个 render-mode.ts
 * 文件删了，类型 inline 到这里。
 * 默认 plaintext —— 用户主动点 MD/TXT 按钮才切到当前 bubble 的本地 state。
 */
type RenderMode = 'plaintext' | 'markdown';
const DEFAULT_RENDER_MODE: RenderMode = 'plaintext';

interface Props {
  sessionId: string;
  agentId: string;
  isSdk: boolean;
}

const EMPTY_EVENTS: AgentEvent[] = [];

export function ActivityFeed({ sessionId, agentId, isSdk }: Props): JSX.Element {
  const recent = useSessionStore((s) => s.recentEventsBySession.get(sessionId) ?? EMPTY_EVENTS);
  const setRecent = useSessionStore((s) => s.setRecentEvents);
  const pendingPermissions = useSessionStore(
    (s) => s.pendingPermissionsBySession.get(sessionId) ?? EMPTY_REQUESTS,
  );
  const pendingAskQuestions = useSessionStore(
    (s) => s.pendingAskQuestionsBySession.get(sessionId) ?? EMPTY_ASK_QUESTIONS,
  );
  const pendingExitPlanModes = useSessionStore(
    (s) => s.pendingExitPlanModesBySession.get(sessionId) ?? EMPTY_EXIT_PLAN_MODES,
  );
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const resolveAsk = useSessionStore((s) => s.resolveAskQuestion);
  const resolveExitPlan = useSessionStore((s) => s.resolveExitPlanMode);
  const setPending = useSessionStore((s) => s.setPendingRequests);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    void window.api.listEvents(sessionId, 100).then((events) => {
      setRecent(sessionId, events);
      setLoaded(true);
    });
    // 同步该会话当前真实的 pending 请求 —— renderer HMR / 切会话后 store 可能跟主进程脱节，
    // 不拉的话事件流里的 permission-request 会被错渲成「已处理」按钮不显示。
    if (isSdk) {
      void window.api.listAdapterPending(agentId, sessionId).then((res) => {
        setPending(sessionId, res.permissions, res.askQuestions, res.exitPlanModes);
      });
    }
  }, [sessionId, agentId, isSdk, setRecent, setPending]);

  if (!loaded && recent.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (recent.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">无活动记录</div>;
  }

  const pendingPermIds = new Set(pendingPermissions.map((r) => r.requestId));
  const pendingAskIds = new Set(pendingAskQuestions.map((r) => r.requestId));
  const pendingExitIds = new Set(pendingExitPlanModes.map((r) => r.requestId));

  // 扫一遍历史事件，收集「被 SDK 取消」过的 requestId 三组集合。
  // SDK 取消 ≠ 用户响应：流终止 / interrupt / 超时时主进程会 emit 一条 `*-cancelled` 事件，
  // 同时把对应 pending 从 store 删掉。光看 stillPending=false 没法区分「用户拒绝/允许」与「被取消」，
  // UI 之前用同一句「已响应或已被 SDK 取消」糊在一起，看不出来到底谁动的。
  const cancelledPermIds = new Set<string>();
  const cancelledAskIds = new Set<string>();
  const cancelledExitIds = new Set<string>();
  for (const e of recent) {
    if (e.kind !== 'waiting-for-user') continue;
    const p = (e.payload ?? {}) as { type?: string; requestId?: string };
    const rid = p.requestId;
    if (!rid) continue;
    if (p.type === 'permission-cancelled') cancelledPermIds.add(rid);
    else if (p.type === 'ask-question-cancelled') cancelledAskIds.add(rid);
    else if (p.type === 'exit-plan-cancelled') cancelledExitIds.add(rid);
  }

  return (
    // select-text 覆盖全局 `#root { user-select: none }`（globals.css 那条是为了拖窗时不选中文字）。
    // 活动流不参与拖窗（拖窗只在 header 的 .drag-region），整体放开方便用户复制对话内容、
    // tool 输出、JSON 入参等；button / select 因 chromium user-agent 默认自带 user-select: none，
    // 不会被影响，textarea / input 本身就可选。
    <ol className="flex flex-col gap-1.5 select-text">
      {recent.map((e, idx) => (
        <ActivityRow
          key={`${e.ts}-${idx}`}
          event={e}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          pendingPermIds={pendingPermIds}
          pendingAskIds={pendingAskIds}
          pendingExitIds={pendingExitIds}
          cancelledPermIds={cancelledPermIds}
          cancelledAskIds={cancelledAskIds}
          cancelledExitIds={cancelledExitIds}
          resolvePermission={resolvePermission}
          resolveAsk={resolveAsk}
          resolveExitPlan={resolveExitPlan}
        />
      ))}
    </ol>
  );
}

interface RowProps {
  event: AgentEvent;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  pendingPermIds: Set<string>;
  pendingAskIds: Set<string>;
  pendingExitIds: Set<string>;
  cancelledPermIds: Set<string>;
  cancelledAskIds: Set<string>;
  cancelledExitIds: Set<string>;
  resolvePermission: (sessionId: string, requestId: string) => void;
  resolveAsk: (sessionId: string, requestId: string) => void;
  resolveExitPlan: (sessionId: string, requestId: string) => void;
}

/**
 * 单条事件渲染。把"可操作"的事件（权限请求、AskUserQuestion、ExitPlanMode）直接内嵌按钮，
 * 把"信息密集"的事件（Edit 类工具调用、tool result）直接展开 diff/结果，
 * 让用户在活动流里就能完成全部交互，不必跳到顶部 banner。
 */
function ActivityRow({
  event,
  sessionId,
  agentId,
  isSdk,
  pendingPermIds,
  pendingAskIds,
  pendingExitIds,
  cancelledPermIds,
  cancelledAskIds,
  cancelledExitIds,
  resolvePermission,
  resolveAsk,
  resolveExitPlan,
}: RowProps): JSX.Element {
  if (event.kind === 'message') {
    return <MessageBubble event={event} />;
  }

  if (event.kind === 'waiting-for-user') {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const type = (p.type as string) ?? '';
    if (type === 'permission-request') {
      const rid = (p.requestId as string) ?? '';
      return (
        <PermissionRow
          event={event}
          payload={p as unknown as PermissionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingPermIds.has(rid)}
          wasCancelled={cancelledPermIds.has(rid)}
          onResolved={resolvePermission}
        />
      );
    }
    if (type === 'ask-user-question') {
      const rid = (p.requestId as string) ?? '';
      return (
        <AskRow
          event={event}
          payload={p as unknown as AskUserQuestionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingAskIds.has(rid)}
          wasCancelled={cancelledAskIds.has(rid)}
          onResolved={resolveAsk}
        />
      );
    }
    if (type === 'exit-plan-mode') {
      const rid = (p.requestId as string) ?? '';
      return (
        <ExitPlanRow
          event={event}
          payload={p as unknown as ExitPlanModeRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingExitIds.has(rid)}
          wasCancelled={cancelledExitIds.has(rid)}
          onResolved={resolveExitPlan}
        />
      );
    }
    return <SimpleRow event={event} />;
  }

  if (event.kind === 'tool-use-start') {
    return <ToolStartRow event={event} sessionId={sessionId} />;
  }

  if (event.kind === 'tool-use-end') {
    return <ToolEndRow event={event} />;
  }

  return <SimpleRow event={event} />;
}

// ───────────────────────── 通用单行

function SimpleRow({ event }: { event: AgentEvent }): JSX.Element {
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-deck-muted/60" />
      <div className="flex-1 leading-relaxed">
        <div className="text-deck-text">{describe(event)}</div>
        <div className="mt-0.5 text-[9px] text-deck-muted/60">
          {new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
      </div>
    </li>
  );
}

// ───────────────────────── 消息气泡

function MessageBubble({ event }: { event: AgentEvent }): JSX.Element {
  const p = (event.payload ?? {}) as { text?: string; role?: 'user' | 'assistant'; error?: boolean };
  const role = p.role === 'user' ? 'user' : 'assistant';
  const text = (p.text ?? '').trim();
  const isError = !!p.error;
  const isUser = role === 'user';
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });

  // 渲染模式：每条消息**独立**持有 mode state，互不级联（CHANGELOG_34 推翻
  // CHANGELOG_27「切单条 = 切全局」的取舍）。默认 plaintext，切换 toggle 只改本条
  // 本地 state；不再有 localStorage 持久化（CHANGELOG_35 删 render-mode.ts）。
  // 副作用：切过的 bubble 卸载（切会话 / 重启）后回到默认；这是有意为之，
  // 不引入「按 message id 持久化偏好 map」的复杂度。
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);

  const toggle = (): void => {
    setMode((cur) => (cur === 'markdown' ? 'plaintext' : 'markdown'));
  };

  // error 消息保留 plaintext，避免 markdown 解析掩盖错误堆栈结构
  const renderAsMarkdown = mode === 'markdown' && !isError && text.length > 0;

  return (
    <li className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[88%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`mb-0.5 flex items-center gap-1 text-[9px] ${
            isUser ? 'text-status-working/80' : 'text-deck-muted/70'
          }`}
        >
          <span>{isUser ? '你' : 'Claude'}</span>
          <span className="text-deck-muted/50">·</span>
          <span className="font-mono tabular-nums text-deck-muted/50">{ts}</span>
          {!isError && text.length > 0 && (
            <button
              type="button"
              onClick={toggle}
              title={mode === 'markdown' ? '切换为纯文本' : '切换为 Markdown'}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/70 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {mode === 'markdown' ? 'MD' : 'TXT'}
            </button>
          )}
        </div>
        <div
          className={`break-words rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${
            isError
              ? 'border border-status-waiting/40 bg-status-waiting/10 text-status-waiting'
              : isUser
                ? 'bg-status-working/15 text-deck-text'
                : 'border border-deck-border bg-white/[0.04] text-deck-text'
          }`}
        >
          {text ? (
            renderAsMarkdown ? (
              <MarkdownText text={text} />
            ) : (
              text
            )
          ) : (
            <span className="text-deck-muted">（空消息）</span>
          )}
        </div>
      </div>
    </li>
  );
}

// ───────────────────────── 权限请求行（内嵌按钮 + diff）

function PermissionRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: PermissionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const diff = toolInputToDiff(payload.toolName, payload.toolInput);

  const respond = async (decision: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (!isSdk || !stillPending) return;
    setBusy(true);
    try {
      await window.api.respondPermission(agentId, sessionId, payload.requestId, {
        decision,
        message: decision === 'deny' ? '用户拒绝' : undefined,
        updatedInput: decision === 'allow' ? payload.toolInput : undefined,
        updatedPermissions: alwaysAllow ? payload.suggestions : undefined,
      });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  // 三态：等待中 / 已被 SDK 取消 / 已响应（用户主动 allow|deny）
  // 「已取消」整张更暗（opacity-50），左侧细色条提示这条是 SDK 放弃的，不是用户操作；
  // 「已响应」保持原样的 70% 透明 + 中性灰描边（用户已经处理过的痕迹，不强调）
  const settled = !stillPending;
  const cardClass = stillPending
    ? 'border-status-waiting/40 bg-status-waiting/10'
    : wasCancelled
      ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
      : 'border-deck-border/60 bg-white/[0.02] opacity-70';
  const statusText = stillPending
    ? '⚠ 等待授权'
    : wasCancelled
      ? '🚫 已被 SDK 取消'
      : '✅ 已响应';
  const statusColor = stillPending
    ? 'text-status-waiting'
    : wasCancelled
      ? 'text-deck-muted/70'
      : 'text-status-working/80';

  return (
    <li className={`rounded-md border p-2 text-[11px] ${cardClass}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className={statusColor}>{statusText}</span>
        <span className="font-mono">{payload.toolName}</span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('allow')}
              className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
            >
              允许本次
            </button>
            {payload.suggestions ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond('allow', true)}
                className="rounded bg-status-working/15 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/25 disabled:opacity-50"
              >
                始终允许
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('deny')}
              className="rounded bg-status-waiting/30 px-2 py-0.5 text-[10px] text-status-waiting hover:bg-status-waiting/40 disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        )}
      </div>
      {diff ? (
        <div className="h-72 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diff} sessionId={sessionId} />
        </div>
      ) : (
        <pre className="max-h-24 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {JSON.stringify(payload.toolInput, null, 2)}
        </pre>
      )}
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">外部 CLI 会话无法在此回应</div>
      )}
      {settled && isSdk && wasCancelled && (
        <div className="mt-1 text-[10px] text-deck-muted/70">
          Claude 主动放弃了这次请求（流终止 / interrupt / 超时）
        </div>
      )}
    </li>
  );
}

// ───────────────────────── AskUserQuestion 行（内嵌选项）

function AskRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: AskUserQuestionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [selections, setSelections] = useState<Record<string, { selected: string[]; other?: string }>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const totalQuestions = payload.questions.length;
  const answeredCount = payload.questions.reduce((acc, q) => {
    const cur = selections[q.question];
    const hasSel = (cur?.selected.length ?? 0) > 0;
    const hasOther = (cur?.other ?? '').trim().length > 0;
    return acc + (hasSel || hasOther ? 1 : 0);
  }, 0);
  const canSubmit = answeredCount === totalQuestions;

  const toggle = (q: AskUserQuestionItem, label: string): void => {
    setSelections((prev) => {
      const cur = prev[q.question] ?? { selected: [], other: undefined };
      const has = cur.selected.includes(label);
      const nextSel = q.multiSelect
        ? has
          ? cur.selected.filter((s) => s !== label)
          : [...cur.selected, label]
        : has
          ? []
          : [label];
      return { ...prev, [q.question]: { selected: nextSel, other: cur.other } };
    });
  };

  const setOther = (q: AskUserQuestionItem, value: string): void => {
    setSelections((prev) => {
      const cur = prev[q.question] ?? { selected: [], other: undefined };
      return { ...prev, [q.question]: { selected: cur.selected, other: value } };
    });
  };

  const submit = async (): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      const answers = payload.questions.map((q) => {
        const cur = selections[q.question] ?? { selected: [], other: undefined };
        return { question: q.question, selected: cur.selected, other: cur.other };
      });
      await window.api.respondAskUserQuestion(agentId, sessionId, payload.requestId, { answers });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={
            stillPending
              ? 'text-status-working'
              : wasCancelled
                ? 'text-deck-muted/70'
                : 'text-status-working/80'
          }
        >
          {stillPending
            ? '❓ Claude 在询问你'
            : wasCancelled
              ? '🚫 提问已被取消'
              : '✅ 已回答'}
        </span>
        {stillPending && (
          <span className="text-deck-muted/80">
            已选 {answeredCount}/{totalQuestions}
          </span>
        )}
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <button
            type="button"
            disabled={busy || answeredCount === 0}
            onClick={() => void submit()}
            title={canSubmit ? '提交回答' : '尚有题目未选，仍可提交（未选项保持空答）'}
            className="ml-auto rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交回答
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {payload.questions.map((q, qi) => {
          const sel = selections[q.question]?.selected ?? [];
          return (
            <div key={qi}>
              <div className="mb-1 text-[11px] text-deck-text">{q.question}</div>
              <div className="flex flex-wrap gap-1">
                {q.options.map((opt) => {
                  const isSel = sel.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={!isSdk || !stillPending || busy}
                      onClick={() => toggle(q, opt.label)}
                      title={opt.description}
                      className={`rounded border px-2 py-0.5 text-[10px] disabled:opacity-50 ${
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
                value={selections[q.question]?.other ?? ''}
                onChange={(e) => setOther(q, e.target.value)}
                placeholder="其他（可选）"
                disabled={!isSdk || !stillPending || busy}
                className="mt-1 w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
              />
            </div>
          );
        })}
      </div>
      {stillPending && isSdk && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-[10px] text-deck-muted">
            {canSubmit ? '已选满，可提交' : `还有 ${totalQuestions - answeredCount} 题未选`}
          </span>
          <button
            type="button"
            disabled={busy || answeredCount === 0}
            onClick={() => void submit()}
            className="rounded bg-status-working px-3 py-1 text-[11px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交回答
          </button>
        </div>
      )}
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">外部 CLI 会话无法在此回应</div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1 text-[10px] text-deck-muted/70">
          Claude 主动取消了这次提问（流终止 / interrupt / 超时）
        </div>
      )}
    </li>
  );
}

// ───────────────────────── ExitPlanMode 行（markdown plan + 二选一按钮）

function ExitPlanRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: ExitPlanModeRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  // 「继续规划」时可选反馈输入框，默认折叠；点了「继续规划」按钮且 feedback 为空时，
  // 展开输入框让用户可以补充意见再确认；如果用户已写过反馈直接发送，跳过 confirm 步骤。
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const plan = payload.plan ?? '';

  const respond = async (decision: 'approve' | 'keep-planning'): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      await window.api.respondExitPlanMode(agentId, sessionId, payload.requestId, {
        decision,
        feedback: decision === 'keep-planning' ? feedback.trim() || undefined : undefined,
      });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  // 「继续规划」按钮：第一次点击展开反馈框（如果还没展开），第二次/已有反馈直接提交。
  // 实战体验：避免每次都强制弹输入框（用户大概率没意见也想直接驳回），
  // 但提供一个「写明白哪儿不满意」的入口，比一句空 deny 让 Claude 瞎猜要好。
  const onClickKeepPlanning = (): void => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    void respond('keep-planning');
  };

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={
            stillPending
              ? 'text-status-working'
              : wasCancelled
                ? 'text-deck-muted/70'
                : 'text-status-working/80'
          }
        >
          {stillPending
            ? '📋 Claude 提议了一个执行计划'
            : wasCancelled
              ? '🚫 计划批准已被取消'
              : '✅ 已处理'}
        </span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('approve')}
              title="批准计划，让 Claude 退出 plan mode 开始执行"
              className="rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              批准计划，开始执行
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClickKeepPlanning}
              title={
                showFeedback
                  ? feedback.trim()
                    ? '把反馈发给 Claude，让它修改计划'
                    : '不写反馈也可以，Claude 会主动询问需要补充哪方面'
                  : '让 Claude 留在 plan mode 继续修改计划（点击后可写反馈）'
              }
              className="rounded border border-deck-border bg-white/[0.06] px-2.5 py-0.5 text-[10px] text-deck-text hover:bg-white/[0.12] disabled:opacity-50"
            >
              继续规划
            </button>
          </div>
        )}
      </div>
      <div className="rounded border border-deck-border/40 bg-black/20 p-2">
        <MarkdownText text={plan || '(plan 内容为空)'} />
      </div>
      {stillPending && isSdk && showFeedback && (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-[10px] text-deck-muted">
            可选：告诉 Claude 哪里需要调整（留空也能提交）
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="比如：步骤 3 不要改 main 进程；先做 UI 验证再写 SDK..."
            rows={2}
            disabled={busy}
            className="w-full resize-none rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowFeedback(false);
                setFeedback('');
              }}
              className="rounded px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/5"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('keep-planning')}
              className="rounded bg-deck-text/80 px-2.5 py-0.5 text-[10px] font-semibold text-deck-bg-strong hover:brightness-110 disabled:opacity-40"
            >
              发送反馈，继续规划
            </button>
          </div>
        </div>
      )}
      {!isSdk && (
        <div className="mt-1.5 text-[10px] text-deck-muted">外部 CLI 会话无法在此批准，请回到对应终端窗口操作</div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1.5 text-[10px] text-deck-muted/70">
          Claude 主动放弃了这次计划批准请求（流终止 / interrupt / 超时）
        </div>
      )}
    </li>
  );
}

// ───────────────────────── tool-use-start（Edit/Write/MultiEdit 内嵌 diff）

function ToolStartRow({
  event,
  sessionId,
}: {
  event: AgentEvent;
  sessionId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tool = (p.toolName as string) ?? '工具';
  const detail = describeToolInput(tool, p.toolInput);
  const diff = toolInputToDiff(tool, p.toolInput);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });

  // ExitPlanMode：hook 通道走这条路（外部 CLI 跑 PreToolUse 时只能拿到 tool-use-start，
  // 拿不到 canUseTool 通路 → SDK 通道不会走这里）。直接展开 plan markdown 让用户能看到内容。
  // 不带按钮（hook 通道无法响应，必须回终端批准）。
  if (tool === 'ExitPlanMode') {
    const plan =
      typeof (p.toolInput as { plan?: unknown })?.plan === 'string'
        ? (p.toolInput as { plan: string }).plan
        : '';
    return (
      <li className="rounded-md border border-status-working/30 bg-status-working/[0.06] p-2 text-[11px]">
        <div className="mb-1 flex items-center gap-1.5 text-[10px]">
          <span>📋</span>
          <span className="font-mono">ExitPlanMode</span>
          <span className="text-deck-muted/80">外部 CLI 提议执行计划</span>
          <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
        </div>
        <div className="rounded border border-deck-border/40 bg-black/20 p-2">
          <MarkdownText text={plan || '(plan 内容为空)'} />
        </div>
        <div className="mt-1.5 text-[10px] text-deck-muted">
          外部 CLI 会话无法在此批准，请回到对应终端窗口操作
        </div>
      </li>
    );
  }

  return (
    <li className="rounded-md border border-deck-border/60 bg-white/[0.02] p-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span>🔧</span>
        <span className="font-mono">{tool}</span>
        {detail && <span className="truncate text-[10px] text-deck-muted">· {detail}</span>}
        <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
      </div>
      {diff && (
        <div className="mt-1 h-72 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diff} sessionId={sessionId} />
        </div>
      )}
    </li>
  );
}

// ───────────────────────── tool-use-end（result 折叠/展开）

function ToolEndRow({ event }: { event: AgentEvent }): JSX.Element {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tool = (p.toolName as string) ?? '工具';
  const result = p.toolResult;
  const [open, setOpen] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const text = formatToolResult(result);
  const hasContent = text && text.trim().length > 0;

  return (
    <li className="rounded-md border border-deck-border/40 bg-white/[0.015] p-2 text-[11px]">
      <button
        type="button"
        onClick={() => hasContent && setOpen((v) => !v)}
        disabled={!hasContent}
        className="flex w-full items-center gap-1.5 text-left disabled:cursor-default"
      >
        <span>{hasContent ? (open ? '▾' : '▸') : '·'}</span>
        <span>{tool} 完成</span>
        <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
      </button>
      {open && hasContent && (
        <pre className="mt-1 max-h-64 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {text}
        </pre>
      )}
    </li>
  );
}

// ───────────────────────── helpers

function describe(e: AgentEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'session-start':
      return `会话开始 · ${(p.cwd as string) ?? ''}`;
    case 'tool-use-start': {
      const tool = (p.toolName as string) ?? '工具';
      if (tool === 'ExitPlanMode') return '📋 Claude 提议了一个执行计划';
      const detail = describeToolInput(tool, p.toolInput);
      return detail ? `🔧 ${tool} · ${detail}` : `🔧 ${tool}`;
    }
    case 'tool-use-end':
      return `${(p.toolName as string) ?? '工具'} 完成`;
    case 'file-changed':
      return `📝 ${(p.filePath as string) ?? ''}`;
    case 'waiting-for-user': {
      const type = (p.type as string) ?? '';
      if (type === 'permission-request') return `⚠ 等待你授权 ${(p.toolName as string) ?? ''}`;
      if (type === 'ask-user-question') return '❓ Claude 在询问你';
      if (type === 'exit-plan-mode') return '📋 Claude 提议了一个执行计划';
      if (type === 'permission-cancelled') return '⚪ 权限请求已被 SDK 取消';
      if (type === 'ask-question-cancelled') return '⚪ 提问已被 SDK 取消';
      if (type === 'exit-plan-cancelled') return '⚪ 计划批准请求已被 SDK 取消';
      return `⚠ 等待你的输入${p.message ? ` · ${p.message as string}` : ''}`;
    }
    case 'finished':
      return '✅ 一轮完成';
    case 'session-end':
      return `⏹ 会话结束${p.reason ? ` · ${p.reason as string}` : ''}`;
    default:
      return e.kind;
  }
}

function describeToolInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
      return typeof o.file_path === 'string' ? o.file_path : null;
    case 'Bash': {
      const cmd = typeof o.command === 'string' ? o.command.replace(/\s+/g, ' ').trim() : '';
      return cmd ? cmd.slice(0, 80) + (cmd.length > 80 ? '…' : '') : null;
    }
    case 'Grep':
    case 'Glob':
      return typeof o.pattern === 'string' ? o.pattern : null;
    case 'ExitPlanMode': {
      // 单行简述：取 plan 第一行或第一句话，让 SimpleRow fallback 也能看到大概内容
      const plan = typeof o.plan === 'string' ? o.plan.trim() : '';
      if (!plan) return null;
      const firstLine = plan.split('\n').find((l) => l.trim()) ?? '';
      return firstLine.slice(0, 80) + (firstLine.length > 80 ? '…' : '');
    }
    default: {
      // 兜底：mcp 图片工具（mcp__<server>__Image*）也走 file_path 摘要
      if (isImageTool(toolName) && typeof o.file_path === 'string') {
        return o.file_path;
      }
      return null;
    }
  }
}

function toolInputToDiff(
  toolName: string,
  input: unknown,
): DiffPayload<string | null> | DiffPayload<ImageSource | null> | null {
  if (!input || typeof input !== 'object') return null;
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
    return { kind: 'text', filePath: i.file_path, before: i.old_string, after: i.new_string, ts };
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
  // mcp 图片工具：tool-use-start 阶段只有 input.file_path，结构如下：
  // - ImageRead 直接展示这张图（before=null, after=path）→ 驱动 ImageDiffRenderer 缩略图视图
  // - 其他图片工具（Write/Edit/MultiEdit）的 before/after 要等 tool_result 才能拿到 server 快照路径，
  //   tool-use-start 阶段返 null 让 ToolStartRow 不画 diff，等 file-changed 事件来画
  if (isImageTool(toolName)) {
    if (toolName.endsWith('__ImageRead')) {
      return {
        kind: 'image',
        filePath: i.file_path,
        before: null,
        after: { kind: 'path', path: i.file_path },
        metadata: { source: 'ImageRead' },
        ts,
      } as DiffPayload<ImageSource | null>;
    }
    return null;
  }
  return null;
}

/** SDK 工具返回的 toolResult 可能是 string、{type,text}[]，或别的结构。 */
function formatToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const block of result) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && b.text) parts.push(b.text);
        else parts.push(JSON.stringify(block));
      } else {
        parts.push(String(block));
      }
    }
    return parts.join('\n');
  }
  if (typeof result === 'object') return JSON.stringify(result, null, 2);
  return String(result);
}
