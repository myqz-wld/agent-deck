/**
 * 跨进程共享：AgentEvent 核心类型。
 * 仅依赖标准库 / TS 自带能力，不引入 Electron / Node 特有 API。
 */

export type AgentEventKind =
  | 'session-start'
  | 'message'
  | 'message-display'
  | 'thinking'
  | 'tool-use-start'
  | 'tool-use-end'
  | 'file-changed'
  | 'context-compaction-start'
  | 'context-compaction-end'
  | 'subagent-start'
  | 'subagent-end'
  | 'waiting-for-user'
  | 'finished'
  | 'session-end'
  | 'team-task-created'
  | 'team-task-completed'
  | 'team-teammate-idle'
  | 'token-usage';

export type AgentToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface AgentEvent<P = unknown> {
  sessionId: string;
  agentId: string;
  kind: AgentEventKind;
  payload: P;
  ts: number;
  /**
   * 事件来源通道。同一 Claude Code 会话可能同时被 SDK 通道（query AsyncGenerator）
   * 和 Hook 通道（settings.json 注入的 hook）观测到，需要据此去重，
   * 否则会重复入库。SDK 通道粒度更细，因此一旦确认某 sessionId 由 SDK 接管，
   * 后续来自 hook 的同 id 事件会被 SessionManager 丢弃。
   */
  source?: 'sdk' | 'hook';
  /** Hook-only origin marker used to reject late SDK-derived events as CLI sessions. */
  hookOrigin?: 'sdk' | 'cli';
}

/** Renderer-safe snapshot of a user message still waiting in a provider input queue. */
export interface PendingOutgoingAttachment {
  /** Message-scoped ordered slot id. It is not a path or a reusable capability. */
  id: string;
  mime: string;
  bytes: number;
}

export interface PendingOutgoingMessage {
  id: string;
  text: string;
  attachments: PendingOutgoingAttachment[];
}

export type PendingOutgoingAttachmentLoadResult =
  | { ok: true; dataUrl: string; mime: string; bytes: number }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'enoent'
        | 'too_big'
        | 'denied'
        | 'invalid_ext'
        | 'io_error'
        | 'unsupported_source';
    };

/** Renderer-safe result of a no-prompt Grok ACP initialize/authenticate probe. */
export interface GrokAuthProbeResult {
  ok: boolean;
  methodId: string | null;
  methods: Array<{ id: string; name: string; type: string }>;
  /** True when Grok inherited exported variables through the user's supported login shell. */
  usedLoginShell: boolean;
  reason?: string;
}
