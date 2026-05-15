/**
 * Agent Deck MCP server 的 7 个 in-process tool 注册 facade（B'0 ADR §3）。
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
 *   - tools/index.ts (本文件，~110 行 facade)
 *   - tools/schemas.ts (~210 行 zod schema)
 *   - tools/helpers.ts (~145 行 ok/err/projectSession/validateExternalCaller/...)
 *   - tools/handlers/{spawn,send,list,get,shutdown}.ts (各 ~50-260 行)
 *   - tools/handlers/archive-plan{,-impl}.ts (plan mcp-bug-and-feature-batch-20260513 Phase 4a)
 *   - tools/handlers/hand-off-session{,-impl}.ts (plan mcp-bug-and-feature-batch-20260513 Phase 4b)
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：协议大简化 10 → 7 tool。
 *   删除 reply_message + wait_reply + check_reply 三个 tool（语法糖 + 阻塞 / 非阻塞 reply
 *   poll），所有消息发送统一走 send_message + reply_to_message_id；reply 不再被
 *   universal-message-watcher 的 J fix 拦截，正常 dispatch 给 lead → SDK emit user-role
 *   message → lead 直接看到 reply 自动 act on it。心智模型大幅简化。
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
  SEND_MESSAGE_SCHEMA,
  SHUTDOWN_SESSION_SCHEMA,
  SPAWN_SESSION_SCHEMA,
  ARCHIVE_PLAN_SCHEMA,
  HAND_OFF_SESSION_SCHEMA,
} from './schemas';
import { spawnSessionHandler } from './handlers/spawn';
import { sendMessageHandler } from './handlers/send';
import { listSessionsHandler } from './handlers/list';
import { getSessionHandler } from './handlers/get';
import { shutdownSessionHandler } from './handlers/shutdown';
import { archivePlanHandler } from './handlers/archive-plan';
import { handOffSessionHandler } from './handlers/hand-off-session';

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
    'Send a user message to an existing session. Routes through the universal-message-watcher (DB envelope + cross-adapter dispatch). Returns immediately after queueing. Pass `reply_to_message_id` to link this message into an existing reply chain (the chain is recorded in DB; lead/teammate see the reply auto-injected as a user-role message in their conversation flow — no need to poll). Multi-team callers must specify `team_id`.',
    SEND_MESSAGE_SCHEMA,
    async (args) => sendMessageHandler(args, makeCtx(args)),
  );

  const listSessions = tool(
    AGENT_DECK_TOOL_NAMES.listSessions,
    'List currently visible sessions (read-only). Returns metadata (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, spawnedBy, spawnDepth) — does NOT include events / messages.',
    LIST_SESSIONS_SCHEMA,
    async (args) => listSessionsHandler(args, makeCtx(args)),
    { annotations: { readOnlyHint: true } },
  );

  const getSession = tool(
    AGENT_DECK_TOOL_NAMES.getSession,
    'Get a single session metadata by id. Returns same projection as list_sessions (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, teams, spawnedBy, spawnDepth) — does NOT include events / messages. Returns isError when session does not exist.',
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
    'Archive a completed plan-driven worktree (K1 hand-off automation): ff-merge worktree branch into base_branch, mv plan file to <main-repo>/plans/<plan_id>.md (status=completed + final_commit + completed_at), sync plans/INDEX.md (followup 20260515: 4-column smart update — `appended`/`updated`/`unchanged`/`created`), git commit, then git worktree remove + branch -D. **CHANGELOG_99: also default-archives the caller session** (with K2 baton semantic — plan completion = caller session\'s mission ends since worktree is gone and cwd is invalidated). Caller must ExitWorktree first (mcp tool cannot call CLI internal ExitWorktree; rejects when process.cwd() is inside worktree). Refuses if plan status is already "completed" or worktree is dirty. Returns { archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_action: \'created\'|\'appended\'|\'updated\'|\'unchanged\', final_status, warnings: string[] (followup 20260515 HIGH-2 silent override 等 non-fatal warning,e.g. `.claude/plans/<id>.md` 与 `plans/<id>.md` 同 id 双存覆盖警告), archived: \'ok\' | \'failed\' | \'skipped\' (CHANGELOG_99 caller archive result; \'failed\' is warn-only and does not block ok return) }. deny external caller (high-risk git+fs writes).',
    ARCHIVE_PLAN_SCHEMA,
    async (args) => archivePlanHandler(args, makeCtx(args)),
  );

  const handOffSession = tool(
    AGENT_DECK_TOOL_NAMES.handOffSession,
    'Start the next SDK session for cross-session hand-off (K2 hand-off automation; **CHANGELOG_99 dual-mode**: plan-driven when `plan_id` is set, generic when omitted). **Plan-driven mode**: read plan frontmatter to derive worktree_path, validate status=in_progress, spawn a new session with cwd=mainRepo (default; CHANGELOG_99 cwd resilience) and auto-constructed cold-start prompt "按 <plan-abs-path> 接力" (optional phase_label appended). **Generic mode** (no plan_id): caller passes `prompt` (defaults to "从上一个会话接力继续工作") and default cwd = caller session cwd; lets any session baton off to a new SDK session without plan/worktree prereq. **Baton semantic (CHANGELOG_97)**: by default does NOT join any team (no lead/teammate role assigned to caller / new session) AND auto-archives the caller session after spawn — the new session takes over independently while the caller exits. Pass team_name explicitly only if you want lead/teammate communication. **CHANGELOG_99 cwd resilience (plan-driven mode)**: default cwd is mainRepo (was worktreePath; changed so new session sessionRepo.cwd survives `archive_plan` / `git worktree remove`). New session expected to run `EnterWorktree(path: worktreePath)` itself per user CLAUDE.md §Step 3. Fallback chain: caller args.cwd > resolved.mainRepo > resolved.worktreePath. Defaults: adapter=claude-code, plan file path resolved from caller cwd via git rev-parse → <main-repo>/.claude/plans/<plan_id>.md, fallback ~/.claude/plans/<plan_id>.md. Returns { mode: \'plan\' | \'generic\', planId, planFilePath, worktreePath, baseBranch, phaseLabel, initialPrompt, ignoredFields: string[] (generic mode warns when caller passed plan-only fields like phase_label / plan_file_path — ignored not error), sessionId, adapter, cwd, teamId (null when no team_name), teamName (null), spawnDepth, sentAt, spawnPromptMessageId (null), archived }. Caller archive failure is warn-only (does not block ok return). deny external caller (SDK session fork bomb risk). **Renamed (CHANGELOG_99)**: was `start_next_session`.',
    HAND_OFF_SESSION_SCHEMA,
    async (args) => handOffSessionHandler(args, makeCtx(args)),
  );

  return [
    spawnSession,
    sendMessage,
    listSessions,
    getSession,
    shutdownSession,
    archivePlan,
    handOffSession,
  ];
}
