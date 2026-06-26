/**
 * Agent Deck MCP server 公共类型（B'0 ADR §2.2 / §3 / §4）。
 *
 * 三 transport（in-process / HTTP / stdio）共享同一份 tool handler，但 caller
 * context 来源各异：
 * - in-process：closure 强制覆盖 args.callerSessionId（防 prompt 注入伪造）
 * - HTTP：从 args.callerSessionId 反查 sessionManager 验证 + Bearer token 鉴权
 * - stdio：从 args.callerSessionId 反查；外部 client 用 `__external__` 字面量
 *
 * tool handler 不 import transport-specific 类型，仅消费 `CallerContext` 与 zod
 * 解析后的 args，便于 B'2.a 同步 tool / send_message 用统一签名实现。
 */

export type AgentDeckMcpTransport = 'in-process' | 'http' | 'stdio';

export const EXTERNAL_CALLER_SENTINEL = '__external__' as const;

/**
 * HookServer.onRequest /mcp 分支注入到 IncomingMessage `req.auth` 的契约
 * （plan codex-handoff-team-alignment-20260518 P2 Step 2.2 / D1 §(b)）。
 *
 * 数据流：fastify onRequest 写 `request.raw.auth: McpAuthInfo` →
 * `transport.handleRequest(req.raw, ...)` 把 IncomingMessage 透传给 mcp-sdk →
 * `streamableHttp.js:130 const authInfo = req.auth` → 注入 tool handler
 * `extra.authInfo: McpAuthInfo` → `transport-http.ts.callerSessionIdOverride` 读取。
 *
 * 三态语义：
 * - **per-session 命中**：`{resolvedSid: '<sid>', fallbackToGlobal: false}` —
 *   token 在 mcpSessionTokenMap 反查命中，handler 用 resolvedSid 当 caller
 * - **全局 fallback**：`{resolvedSid: null, fallbackToGlobal: true}` —
 *   token 不在 per-session map 但等于全局 mcpServerToken，handler 视为
 *   external caller（EXTERNAL_CALLER_ALLOWED 表 spawn/send/shutdown 全 deny）
 * - **不存在**：onRequest 直接 401，handler 收不到这种 case
 */
export interface McpAuthInfo {
  resolvedSid: string | null;
  fallbackToGlobal: boolean;
}

export interface CallerContext {
  /**
   * 调用方 session id。in-process 走 closure 覆盖（无视 args 字段），HTTP/stdio
   * 直接用 args.callerSessionId 反查 sessionManager。
   * 特殊值 `__external__`：stdio transport 的非 agent-deck-managed client（如
   * Cursor / Continue），仅允许 list_sessions / get_session 等只读 tool；spawn /
   * shutdown 默认 deny（ADR §4.3 / §11.7）。
   */
  callerSessionId: string;
  /**
   * spawn 链路上一级 session id。spawn_session 的 args 显式传 → 用之；
   * 否则默认 = callerSessionId（caller 自己即为 parent）。
   */
  parentSessionId?: string;
  transport: AgentDeckMcpTransport;
}

/** Agent Deck MCP tool names. Public registry exposes 19 tools; archive/teammate cleanup names are retained only as deny-by-default guard keys for old internal handlers. */
export const AGENT_DECK_TOOL_NAMES = {
  spawnSession: 'spawn_session',
  sendMessage: 'send_message',
  presentPlan: 'present_plan',
  presentDiff: 'present_diff',
  listSessions: 'list_sessions',
  getSession: 'get_session',
  listSessionEvents: 'list_session_events',
  shutdownSession: 'shutdown_session',
  // Retained guard key, not registered by buildAgentDeckTools.
  archivePlan: 'archive_plan',
  handOffSession: 'hand_off_session',
  enterWorktree: 'enter_worktree',
  exitWorktree: 'exit_worktree',
  // Retained guard key, not registered by buildAgentDeckTools.
  shutdownBatonTeammates: 'shutdown_baton_teammates',
  // plan task-mcp-merge-into-agent-deck-mcp-20260521：5 个 task tool 合并入 agent-deck namespace
  // （工具名从 mcp__tasks__task_* 切到 mcp__agent-deck__task_*，breaking change）。
  taskCreate: 'task_create',
  taskList: 'task_list',
  taskGet: 'task_get',
  taskUpdate: 'task_update',
  taskDelete: 'task_delete',
  // plan issue-tracker-mcp-20260529 §Step 3.3.4 + 体验改进 20260531 §需求3：3 个 issue write tool。
  // report_issue / append_issue_context 仍不挂 read/admin（agent 只写不查 — UI 负责 read/admin）；
  // update_issue_status 是受控开口（仅源 / 解决会话能改自己关联 issue 的 status，其余 admin 仍走 UI）。
  reportIssue: 'report_issue',
  appendIssueContext: 'append_issue_context',
  updateIssueStatus: 'update_issue_status',
} as const;

export type AgentDeckToolName =
  (typeof AGENT_DECK_TOOL_NAMES)[keyof typeof AGENT_DECK_TOOL_NAMES];

/**
 * External caller allow-list. Unknown or omitted entries are treated as denied by helper code;
 * retired guard keys remain explicit false so old imports never become callable through external transport.
 */
export const EXTERNAL_CALLER_ALLOWED: Record<AgentDeckToolName, boolean> = {
  spawn_session: false,
  send_message: false,
  present_plan: false,
  present_diff: false,
  list_sessions: true,
  get_session: true,
  // Requires a real caller identity for self/spawn/team visibility checks even though it is read-only.
  list_session_events: false,
  shutdown_session: false,
  archive_plan: false,
  hand_off_session: false,
  enter_worktree: false,
  exit_worktree: false,
  shutdown_baton_teammates: false,
  // task tools (plan task-mcp-merge-into-agent-deck-mcp-20260521 §D6 R1 F1 + v024 §D8)
  task_create: false,
  task_update: false,
  task_delete: false,
  task_list: true,
  // v024 plan §D8 修法:flip true → false（严格 team-scoped read + deny external 对称）
  task_get: false,
  // plan issue-tracker-mcp-20260529 §不变量 7 + 体验改进 20260531 §需求3：3 个 issue write tool 都 deny external
  // （写 issues 表 + sourceSessionId 闭包注入 / 授权校验需真实 in-process callerSessionId,external client
  // 没法提供 source-bound / 源-解决会话授权校验需要的 in-process closure caller）。**没有** issue_list /
  // issue_get / issue_delete — read/admin 走 UI（IPC channels 路径,与 mcp transport 隔离）;唯一 agent 开口
  // 是 update_issue_status 让源 / 解决会话自助推进 status。
  report_issue: false,
  append_issue_context: false,
  update_issue_status: false,
};
