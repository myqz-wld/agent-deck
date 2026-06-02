/**
 * 跨进程共享：AgentEvent 核心类型。
 * 仅依赖标准库 / TS 自带能力，不引入 Electron / Node 特有 API。
 */

export type AgentEventKind =
  | 'session-start'
  | 'message'
  | 'thinking'
  | 'tool-use-start'
  | 'tool-use-end'
  | 'file-changed'
  | 'waiting-for-user'
  | 'finished'
  | 'session-end'
  | 'team-task-created'
  | 'team-task-completed'
  | 'team-teammate-idle'
  | 'token-usage';

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
  /**
   * REVIEW_12 Bug 5：仅 hook 通道事件携带，标记该 CLI 子进程是否由本应用 SDK 派生。
   * - `'sdk'`：SDK spawn 出的 CLI 子进程（含其内部 fork 出的子会话），env 注入
   *   `AGENT_DECK_ORIGIN=sdk` → hook curl 转发 `X-Agent-Deck-Origin: sdk` header
   * - `'cli'`：完全独立的 CLI 进程（用户在终端跑 `claude`），无 env → header 走默认 'cli'
   * - `undefined`：老版本 hook 命令未携带（升级前 settings.json 里残留），按 'cli' 兼容
   *
   * 用途：ingest 入口识别「OLD CLI 被 SIGTERM 后飞回的迟到 hook event 用了新 sessionId
   * + cwd=home」这类孤儿 SDK-derived hook，避免误创建 source='cli' record
   * （典型 approve-bypass 冷切场景）。不依赖 sessionId / cwd 等会被 CLI 内部 fork 错乱的值。
   */
  hookOrigin?: 'sdk' | 'cli';
}
