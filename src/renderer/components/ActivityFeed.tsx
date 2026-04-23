import { useEffect, useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
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
import { ImageThumb } from './ImageThumb';
import { AskRow, ExitPlanRow, PermissionRow, toolInputToDiff } from './pending-rows';

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
    return <ToolEndRow event={event} sessionId={sessionId} />;
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

// ───────────────────────── 待处理 Row（PermissionRow / AskRow / ExitPlanRow）
// 已迁移至 ./pending-rows，与 PendingTab 共用。本文件顶部已 import。

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

// ───────────────────────── tool-use-end（result 折叠/展开 + image-read 缩略图卡片）

function ToolEndRow({
  event,
  sessionId,
}: {
  event: AgentEvent;
  sessionId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tool = (p.toolName as string) ?? '工具';
  const result = p.toolResult ?? p.toolResponse;
  const [open, setOpen] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const text = formatToolResult(result);
  const hasContent = text && text.trim().length > 0;

  // 尝试解析为 mcp 图片工具结果；image-read 走特殊渲染（缩略图 + 描述）
  // 其他 image-* kinds 不需要在 ToolEndRow 显示 — 由 file-changed → ImageDiffRenderer 接管
  const imageRead = parseImageReadResult(result);

  return (
    <li className="rounded-md border border-deck-border/40 bg-white/[0.015] p-2 text-[11px]">
      <button
        type="button"
        onClick={() => hasContent && setOpen((v) => !v)}
        disabled={!hasContent}
        className="flex w-full items-center gap-1.5 text-left disabled:cursor-default"
      >
        <span>{hasContent ? (open ? '▾' : '▸') : '·'}</span>
        <span>
          {imageRead ? '🖼 ImageRead' : tool} 完成
          {imageRead?.provider && (
            <span className="ml-1.5 text-[9px] text-deck-muted/70">
              [{imageRead.provider}
              {imageRead.model ? ` · ${imageRead.model}` : ''}]
            </span>
          )}
        </span>
        <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
      </button>
      {imageRead && (
        <div className="mt-2 flex gap-2">
          <ImageThumb
            sessionId={sessionId}
            source={{ kind: 'path', path: imageRead.file }}
            size="md"
          />
          <div className="flex-1 overflow-hidden">
            <div className="text-[9px] uppercase tracking-wider text-deck-muted">描述</div>
            <div className="mt-0.5 max-h-40 overflow-auto scrollbar-deck whitespace-pre-wrap text-[11px] text-deck-text/90">
              {imageRead.description}
            </div>
          </div>
        </div>
      )}
      {open && hasContent && (
        <pre className="mt-1 max-h-64 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {text}
        </pre>
      )}
    </li>
  );
}

/**
 * 解析 toolResult 是不是 mcp ImageRead 的结构化返回。
 * agent-deck-image-mcp 把 ImageToolResult JSON.stringify 后塞在 content[0].text 里。
 * 这里宽松解析（兼容 string content / Block[] content 两种形态），匹配 kind === 'image-read' 才返回。
 */
function parseImageReadResult(content: unknown): {
  file: string;
  description: string;
  provider?: string;
  model?: string;
} | null {
  if (content == null) return null;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let parsed: unknown = null;
  if (typeof content === 'string') {
    parsed = tryParse(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object') {
        const bb = b as { type?: string; text?: string };
        if (bb.type === 'text' && typeof bb.text === 'string') {
          parsed = tryParse(bb.text);
          if (parsed) break;
        }
      }
    }
  }
  const v = parsed as
    | {
        kind?: string;
        file?: unknown;
        description?: unknown;
        provider?: unknown;
        model?: unknown;
      }
    | null;
  if (!v || v.kind !== 'image-read') return null;
  if (typeof v.file !== 'string' || typeof v.description !== 'string') return null;
  return {
    file: v.file,
    description: v.description,
    ...(typeof v.provider === 'string' ? { provider: v.provider } : {}),
    ...(typeof v.model === 'string' ? { model: v.model } : {}),
  };
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

// toolInputToDiff 已迁移至 ./pending-rows（与 PermissionRow 共用），本文件顶部已 import。

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
