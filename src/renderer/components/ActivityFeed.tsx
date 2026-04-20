import { useEffect, useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  DiffPayload,
  PermissionRequest,
} from '@shared/types';
import {
  EMPTY_ASK_QUESTIONS,
  EMPTY_REQUESTS,
  useSessionStore,
} from '@renderer/stores/session-store';
import { DiffViewer } from './diff/DiffViewer';

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
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const resolveAsk = useSessionStore((s) => s.resolveAskQuestion);
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
        setPending(sessionId, res.permissions, res.askQuestions);
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

  return (
    <ol className="flex flex-col gap-1.5">
      {recent.map((e, idx) => (
        <ActivityRow
          key={`${e.ts}-${idx}`}
          event={e}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          pendingPermIds={pendingPermIds}
          pendingAskIds={pendingAskIds}
          resolvePermission={resolvePermission}
          resolveAsk={resolveAsk}
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
  resolvePermission: (sessionId: string, requestId: string) => void;
  resolveAsk: (sessionId: string, requestId: string) => void;
}

/**
 * 单条事件渲染。把"可操作"的事件（权限请求、AskUserQuestion）直接内嵌按钮，
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
  resolvePermission,
  resolveAsk,
}: RowProps): JSX.Element {
  if (event.kind === 'message') {
    return <MessageBubble event={event} />;
  }

  if (event.kind === 'waiting-for-user') {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const type = (p.type as string) ?? '';
    if (type === 'permission-request') {
      return (
        <PermissionRow
          event={event}
          payload={p as unknown as PermissionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingPermIds.has((p.requestId as string) ?? '')}
          onResolved={resolvePermission}
        />
      );
    }
    if (type === 'ask-user-question') {
      return (
        <AskRow
          event={event}
          payload={p as unknown as AskUserQuestionRequest}
          sessionId={sessionId}
          agentId={agentId}
          isSdk={isSdk}
          stillPending={pendingAskIds.has((p.requestId as string) ?? '')}
          onResolved={resolveAsk}
        />
      );
    }
    return <SimpleRow event={event} />;
  }

  if (event.kind === 'tool-use-start') {
    return <ToolStartRow event={event} />;
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
        </div>
        <div
          className={`whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
            isError
              ? 'border border-status-waiting/40 bg-status-waiting/10 text-status-waiting'
              : isUser
                ? 'bg-status-working/15 text-deck-text'
                : 'border border-deck-border bg-white/[0.04] text-deck-text'
          }`}
        >
          {text || <span className="text-deck-muted">（空消息）</span>}
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
  onResolved,
}: {
  event: AgentEvent;
  payload: PermissionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
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

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-waiting/40 bg-status-waiting/10'
          : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className={stillPending ? 'text-status-waiting' : 'text-deck-muted'}>
          {stillPending ? '⚠ 等待授权' : '⚪ 已处理'}
        </span>
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
          <DiffViewer payload={diff} />
        </div>
      ) : (
        <pre className="max-h-24 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {JSON.stringify(payload.toolInput, null, 2)}
        </pre>
      )}
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">外部 CLI 会话无法在此回应</div>
      )}
      {!stillPending && isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">已响应或已被 SDK 取消</div>
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
  onResolved,
}: {
  event: AgentEvent;
  payload: AskUserQuestionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
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
          : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className={stillPending ? 'text-status-working' : 'text-deck-muted'}>
          {stillPending ? '❓ Claude 在询问你' : '⚪ 已回答'}
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
    </li>
  );
}

// ───────────────────────── tool-use-start（Edit/Write/MultiEdit 内嵌 diff）

function ToolStartRow({ event }: { event: AgentEvent }): JSX.Element {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tool = (p.toolName as string) ?? '工具';
  const detail = describeToolInput(tool, p.toolInput);
  const diff = toolInputToDiff(tool, p.toolInput);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });

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
          <DiffViewer payload={diff} />
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
      if (type === 'permission-cancelled') return '⚪ 权限请求已被 SDK 取消';
      if (type === 'ask-question-cancelled') return '⚪ 提问已被 SDK 取消';
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
    default:
      return null;
  }
}

function toolInputToDiff(
  toolName: string,
  input: unknown,
): DiffPayload<string | null> | null {
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
