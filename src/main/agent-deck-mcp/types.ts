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
   * 直接用 args.caller_session_id 反查 sessionManager。
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

/**
 * Agent Deck MCP tool 7 个名字常量集中地。
 * 文档（README + skill）+ 防御性 deny 决策（B'5 / B'2.a）共用。
 *
 * plan mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.1：加 archive_plan tool
 * —— K1 hand-off 自动化 plan 收口（git ff merge / mv plan / commit / worktree remove /
 * branch -D 一次调用代替原 user CLAUDE.md §Step 4 cleanup 5 步 Bash）。
 *
 * plan mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.1：加 hand_off_session tool
 * （CHANGELOG_99 改名前 `start_next_session`）
 * —— K2 hand-off 自动化「跨会话接力」起新 SDK session（双模式 spawn_session 包装：
 * plan-driven 模式读 plan frontmatter 拿 worktree_path 自动构造 cold-start prompt；
 * generic 模式无需 plan，caller 显式传 prompt + 默认 cwd = caller cwd，让任意会话都能
 * baton 交给一个新 session）。
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：协议大简化 10 → 7 tool。
 * 删 reply_message + wait_reply + check_reply 三个 tool；caller 改用
 * send_message + reply_to_message_id；reply 自动 dispatch 进 lead conversation flow，
 * 无需主动 poll。J fix 拦截删（universal-message-watcher 不再特别拦 reply）。
 *
 * plan codex-handoff-team-alignment-20260518 P1 Step 1.2 / D2 + 不变量 5：
 * 加 enter_worktree + exit_worktree 两个 tool — 7 → 9 tool。给 codex / 跨 adapter caller
 * 提供 claude builtin EnterWorktree / ExitWorktree 的等价能力,让 archive_plan 预检走 4
 * 态分流时认得跨 adapter 路径(详 P1 Step 1.4 archive-plan-impl.ts)。
 */
export const AGENT_DECK_TOOL_NAMES = {
  spawnSession: 'spawn_session',
  sendMessage: 'send_message',
  listSessions: 'list_sessions',
  getSession: 'get_session',
  shutdownSession: 'shutdown_session',
  archivePlan: 'archive_plan',
  handOffSession: 'hand_off_session',
  enterWorktree: 'enter_worktree',
  exitWorktree: 'exit_worktree',
} as const;

export type AgentDeckToolName =
  (typeof AGENT_DECK_TOOL_NAMES)[keyof typeof AGENT_DECK_TOOL_NAMES];

/**
 * 注册到 in-process MCP / HTTP / stdio 的 tool 是否允许「外部 caller」调用。
 * spawn_session / send_message / shutdown_session / archive_plan / hand_off_session /
 * enter_worktree / exit_worktree 默认 deny external（防 fork bomb / 越权 IPC / 高风险
 * git+fs 写 / 起 SDK session 的 fork bomb / setMarker 需 per-session 真实 caller_session_id）；
 * list_sessions / get_session 是只读 / 观察类，允许 external。
 */
export const EXTERNAL_CALLER_ALLOWED: Record<AgentDeckToolName, boolean> = {
  spawn_session: false,
  send_message: false,
  list_sessions: true,
  get_session: true,
  shutdown_session: false,
  archive_plan: false,
  hand_off_session: false,
  enter_worktree: false,
  exit_worktree: false,
};
