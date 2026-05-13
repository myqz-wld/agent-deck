/**
 * Agent Deck MCP server 公共类型（B'0 ADR §2.2 / §3 / §4）。
 *
 * 三 transport（in-process / HTTP / stdio）共享同一份 tool handler，但 caller
 * context 来源各异：
 * - in-process：closure 强制覆盖 args.caller_session_id（防 prompt 注入伪造）
 * - HTTP：从 args.caller_session_id 反查 sessionManager 验证 + Bearer token 鉴权
 * - stdio：从 args.caller_session_id 反查；外部 client 用 `__external__` 字面量
 *
 * tool handler 不 import transport-specific 类型，仅消费 `CallerContext` 与 zod
 * 解析后的 args，便于 B'2.a 同步 tool / B'2.b wait_reply 用统一签名实现。
 */

export type AgentDeckMcpTransport = 'in-process' | 'http' | 'stdio';

export const EXTERNAL_CALLER_SENTINEL = '__external__' as const;

export interface CallerContext {
  /**
   * 调用方 session id。in-process 走 closure 覆盖（无视 args 字段），HTTP/stdio
   * 直接用 args.caller_session_id 反查 sessionManager。
   * 特殊值 `__external__`：stdio transport 的非 agent-deck-managed client（如
   * Cursor / Continue），仅允许 list_sessions / wait_reply 等只读 tool；spawn /
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

/**
 * Agent Deck MCP tool 10 个名字常量集中地。
 * 文档（README + skill）+ 防御性 deny 决策（B'5 / B'2.a）共用。
 *
 * plan team-cohesion-fix-20260513 Phase B Step B3：加 reply_message tool（语法糖）
 * —— teammate 收到 user message 后调此 tool 回复，无需手动算 to_session_id / team_id。
 *
 * plan mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.1：加 archive_plan tool
 * —— K1 hand-off 自动化 plan 收口（git ff merge / mv plan / commit / worktree remove /
 * branch -D 一次调用代替原 user CLAUDE.md §Step 4 cleanup 5 步 Bash）。
 *
 * plan mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.1：加 start_next_session tool
 * —— K2 hand-off 自动化「跨会话接力」起新 SDK session（plan-aware spawn_session 包装：
 * 读 plan frontmatter 拿 worktree_path → 调 spawn_session 起新 session + 自动 cold start
 * prompt「按 <plan-abs-path> 接力」+ 自动加入 plan-id team）。
 */
export const AGENT_DECK_TOOL_NAMES = {
  spawnSession: 'spawn_session',
  sendMessage: 'send_message',
  replyMessage: 'reply_message',
  waitReply: 'wait_reply',
  checkReply: 'check_reply',
  listSessions: 'list_sessions',
  getSession: 'get_session',
  shutdownSession: 'shutdown_session',
  archivePlan: 'archive_plan',
  startNextSession: 'start_next_session',
} as const;

export type AgentDeckToolName =
  (typeof AGENT_DECK_TOOL_NAMES)[keyof typeof AGENT_DECK_TOOL_NAMES];

/**
 * 注册到 in-process MCP / HTTP / stdio 的 tool 是否允许「外部 caller」调用。
 * spawn_session / send_message / reply_message / shutdown_session / archive_plan /
 * start_next_session 默认 deny external（防 fork bomb / 越权 IPC / 高风险 git+fs 写 /
 * 起 SDK session 的 fork bomb）；list_sessions / get_session / wait_reply / check_reply
 * 是只读 / 观察类，允许 external。
 */
export const EXTERNAL_CALLER_ALLOWED: Record<AgentDeckToolName, boolean> = {
  spawn_session: false,
  send_message: false,
  reply_message: false,
  wait_reply: true,
  check_reply: true,
  list_sessions: true,
  get_session: true,
  shutdown_session: false,
  archive_plan: false,
  start_next_session: false,
};
