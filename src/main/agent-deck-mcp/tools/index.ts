/**
 * Agent Deck MCP server 的 10 个 in-process tool 注册 facade（B'0 ADR §3）。
 *
 * 三 transport（in-process / HTTP / stdio）共享同一份 buildAgentDeckTools 输出；
 * transport 层负责 caller-id 注入策略：
 * - in-process（B'3）：closure 强制覆盖 args.caller_session_id（防 prompt 注入伪造）
 * - HTTP/stdio：args.caller_session_id 必填，handler 内反查 sessionManager
 *
 * 字段命名约定：tool args **snake_case**（与 task-manager 既有约定一致），
 * 内部 TS 接口 camelCase。
 *
 * 拆分历史（CHANGELOG_81 / plan deep-review-and-split-20260513 H2 Step 2.1）：
 *   原 src/main/agent-deck-mcp/tools.ts (1060 行) 拆为：
 *   - tools/index.ts (本文件，~140 行 facade)
 *   - tools/schemas.ts (~270 行 zod schema)
 *   - tools/helpers.ts (~190 行 ok/err/projectSession/validateExternalCaller/...)
 *   - tools/handlers/{spawn,send,reply,wait,check,list,get,shutdown}.ts (各 ~50-260 行)
 *   - tools/handlers/archive-plan{,-impl}.ts (plan mcp-bug-and-feature-batch-20260513 Phase 4a)
 *   - tools/handlers/start-next-session{,-impl}.ts (plan mcp-bug-and-feature-batch-20260513 Phase 4b)
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { AGENT_DECK_TOOL_NAMES, type CallerContext } from '../types';

import {
  makeCallerContext,
  type HandlerContext,
} from './helpers';
import {
  GET_SESSION_SCHEMA,
  LIST_SESSIONS_SCHEMA,
  REPLY_MESSAGE_SCHEMA,
  SEND_MESSAGE_SCHEMA,
  SHUTDOWN_SESSION_SCHEMA,
  SPAWN_SESSION_SCHEMA,
  WAIT_REPLY_SCHEMA,
  CHECK_REPLY_SCHEMA,
  ARCHIVE_PLAN_SCHEMA,
  START_NEXT_SESSION_SCHEMA,
} from './schemas';
import { spawnSessionHandler } from './handlers/spawn';
import { sendMessageHandler } from './handlers/send';
import { replyMessageHandler } from './handlers/reply';
import { waitReplyHandler } from './handlers/wait';
import { checkReplyHandler } from './handlers/check';
import { listSessionsHandler } from './handlers/list';
import { getSessionHandler } from './handlers/get';
import { shutdownSessionHandler } from './handlers/shutdown';
import { archivePlanHandler } from './handlers/archive-plan';
import { startNextSessionHandler } from './handlers/start-next-session';

// helpers 子集 re-export，保持老 caller 兼容（外部对 makeCallerContext / denyExternalIfNotAllowed
// 的 import 路径 `from './tools'` 仍能 resolve）。
export {
  makeCallerContext,
  denyExternalIfNotAllowed,
  _internalOk,
  _internalErr,
} from './helpers';

export interface BuildAgentDeckToolsDeps {
  /**
   * in-process transport 强制覆盖 caller_session_id 的 lazy provider；
   * HTTP / stdio transport 传 null（用 args.caller_session_id）。
   */
  callerSessionIdOverride: (() => string | null) | null;
  /** transport 类型，写入 CallerContext.transport 字段供 handler 决策。 */
  transport: CallerContext['transport'];
}

export async function buildAgentDeckTools(
  deps: BuildAgentDeckToolsDeps,
): Promise<SdkMcpToolDefinition<any>[]> {
  const { tool } = await loadSdk();
  const { transport, callerSessionIdOverride } = deps;

  /**
   * 把 zod 解析后的 args 字段（含 caller_session_id / parent_session_id）规范成
   * HandlerContext。in-process transport 用 closure override 覆盖伪造的 caller_session_id。
   */
  function makeCtx(args: {
    caller_session_id?: string;
    parent_session_id?: string;
  }): HandlerContext {
    const overridden = callerSessionIdOverride?.() ?? null;
    const callerSid = overridden ?? args.caller_session_id;
    return {
      caller: makeCallerContext(callerSid, args.parent_session_id, transport),
    };
  }

  const spawnSession = tool(
    AGENT_DECK_TOOL_NAMES.spawnSession,
    'Spawn a new agent session via the given adapter (claude-code / codex-cli / aider / generic-pty). Returns the new sessionId. Subject to depth / per-parent fan-out / per-app rate-limit (see Agent Deck Settings → MCP Server). caller_session_id is required (in-process transport overrides with the real session id).',
    SPAWN_SESSION_SCHEMA,
    async (args) => spawnSessionHandler(args, makeCtx(args)),
  );

  const sendMessage = tool(
    AGENT_DECK_TOOL_NAMES.sendMessage,
    'Send a user message to an existing session. Routes through the universal-message-watcher (DB envelope + cross-adapter dispatch). Returns immediately after queueing — use wait_reply to observe the response. Multi-team callers must specify team_id.',
    SEND_MESSAGE_SCHEMA,
    async (args) => sendMessageHandler(args, makeCtx(args)),
  );

  const replyMessage = tool(
    AGENT_DECK_TOOL_NAMES.replyMessage,
    'Reply to an existing message in the same team. Convenience wrapper around send_message: auto-resolves to_session_id (= original message.from_session_id) and team_id (= original message.team_id), and sets reply_to_message_id automatically. Use this when you (lead or teammate) received a message and want to respond — the wait_reply tool on the other side will resolve once your reply is delivered. Returns immediately after queueing.',
    REPLY_MESSAGE_SCHEMA,
    async (args) => replyMessageHandler(args, makeCtx(args)),
  );

  const waitReply = tool(
    AGENT_DECK_TOOL_NAMES.waitReply,
    'Wait for a reply to a specific message id. Resolves when a message with reply_to_message_id = this id is delivered (DB query + universal-message-watcher event listener). Optionally sends a nudge_text after nudge_after_ms if no reply arrives — useful when the recipient may have forgotten to call reply_message. Returns { reply: { messageId, text, sentAt, fromSessionId } | null, nudgesSent, nudgeMessageIds: string[], timedOut }. nudgeMessageIds collects every nudge messageId enqueued during this wait — internal double-lookup logic (originalId + nudgeIds) already auto-resolves when teammate replies to the nudge id (default behavior per reviewer wire format protocol), so caller need not poll nudgeIds explicitly; field exposed for diagnostic / sidecar check_reply use.',
    WAIT_REPLY_SCHEMA,
    async (args) => waitReplyHandler(args, makeCtx(args)),
    { annotations: { readOnlyHint: false } }, // wait_reply 现在可能 enqueue nudge，不再纯 read-only
  );

  const checkReply = tool(
    AGENT_DECK_TOOL_NAMES.checkReply,
    'Non-blocking poll for a reply to a specific message id. Returns immediately with { reply: { messageId, text, sentAt, fromSessionId } | null, timedOut: false } (timedOut is always false; field kept for shape parity with wait_reply). Unlike wait_reply, never blocks — caller polls at its own cadence and can interleave handling other user input. Use this when you have other work to do while a teammate is processing.',
    CHECK_REPLY_SCHEMA,
    async (args) => checkReplyHandler(args, makeCtx(args)),
    { annotations: { readOnlyHint: true } },
  );

  const listSessions = tool(
    AGENT_DECK_TOOL_NAMES.listSessions,
    'List currently visible sessions (read-only). Returns metadata (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, spawnedBy, spawnDepth) — does NOT include events / messages (use wait_reply for those).',
    LIST_SESSIONS_SCHEMA,
    async (args) => listSessionsHandler(args, makeCtx(args)),
    { annotations: { readOnlyHint: true } },
  );

  const getSession = tool(
    AGENT_DECK_TOOL_NAMES.getSession,
    'Get a single session metadata by id. Returns same projection as list_sessions (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, teams, spawnedBy, spawnDepth) — does NOT include events / messages (use wait_reply for those). Returns isError when session does not exist.',
    GET_SESSION_SCHEMA,
    async (args) => getSessionHandler(args, makeCtx(args)),
    { annotations: { readOnlyHint: true } },
  );

  const shutdownSession = tool(
    AGENT_DECK_TOOL_NAMES.shutdownSession,
    'Mark a session as closed (lifecycle=closed) + abort its SDK live query. Does NOT delete events / file_changes / summaries / messages — they remain queryable (lead can still cite closed teammate replies in deep-review aftermath; list_sessions(spawned_by_filter) still finds closed children). team_member soft-exit via left_at; spawn_link kept whole. caller cannot shutdown self.',
    SHUTDOWN_SESSION_SCHEMA,
    async (args) => shutdownSessionHandler(args, makeCtx(args)),
  );

  const archivePlan = tool(
    AGENT_DECK_TOOL_NAMES.archivePlan,
    'Archive a completed plan-driven worktree (K1 hand-off automation): ff-merge worktree branch into base_branch, mv plan file to <main-repo>/plans/<plan_id>.md (status=completed + final_commit + completed_at), append plans/INDEX.md, git commit, then git worktree remove + branch -D. Caller must ExitWorktree first (mcp tool cannot call CLI internal ExitWorktree; rejects when process.cwd() is inside worktree). Refuses if plan status is already "completed" or worktree is dirty. Returns { archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_appended, final_status }. deny external caller (high-risk git+fs writes).',
    ARCHIVE_PLAN_SCHEMA,
    async (args) => archivePlanHandler(args, makeCtx(args)),
  );

  const startNextSession = tool(
    AGENT_DECK_TOOL_NAMES.startNextSession,
    'Start the next plan-driven SDK session for cross-session hand-off (K2 hand-off automation): read plan frontmatter to derive worktree_path, validate status=in_progress, then spawn a new session with cwd=worktree_path and an auto-generated cold-start prompt "按 <plan-abs-path> 接力" (optional phase_label appended). **Baton semantic (CHANGELOG_97)**: by default does NOT join any team (no lead/teammate role assigned to caller / new session) AND auto-archives the caller session after spawn — the new session takes over independently while the caller exits. Pass team_name explicitly only if you want lead/teammate communication. Defaults: adapter=claude-code, plan file path resolved from caller cwd via git rev-parse → <main-repo>/.claude/plans/<plan_id>.md, fallback ~/.claude/plans/<plan_id>.md. Returns { planId, planFilePath, worktreePath, baseBranch, phaseLabel, initialPrompt, sessionId, adapter, cwd, teamId (null when no team_name), teamName (null), spawnDepth, sentAt, spawnPromptMessageId (null) }. Caller archive failure is warn-only (does not block ok return). deny external caller (SDK session fork bomb risk).',
    START_NEXT_SESSION_SCHEMA,
    async (args) => startNextSessionHandler(args, makeCtx(args)),
  );

  return [
    spawnSession,
    sendMessage,
    replyMessage,
    waitReply,
    checkReply,
    listSessions,
    getSession,
    shutdownSession,
    archivePlan,
    startNextSession,
  ];
}
