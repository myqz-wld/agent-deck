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
 *   - tools/index.ts (本文件，~110 行 facade)
 *   - tools/schemas.ts (~210 行 zod schema)
 *   - tools/helpers.ts (~145 行 ok/err/projectSession/validateExternalCaller/...)
 *   - tools/handlers/{spawn,send,list,get,shutdown}.ts (各 ~50-260 行)
 *   - tools/handlers/archive-plan{,-impl}.ts (plan mcp-bug-and-feature-batch-20260513 Phase 4a)
 *   - tools/handlers/hand-off-session{,-impl}.ts (plan mcp-bug-and-feature-batch-20260513 Phase 4b)
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：协议大简化，删除旧 reply polling
 *   三件套（语法糖 + 阻塞 / 非阻塞 reply poll），所有消息发送统一走 send_message +
 *   reply_to_message_id；reply 不再被
 *   universal-message-watcher 的 J fix 拦截，正常 dispatch 给 lead → SDK emit user-role
 *   message → lead 直接看到 reply 自动 act on it。心智模型大幅简化。
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { AGENT_DECK_TOOL_NAMES, type CallerContext } from '../types';

import {
  makeCallerContext,
  err,
  type HandlerContext,
} from './helpers';
import {
  GET_SESSION_SCHEMA,
  LIST_SESSIONS_SCHEMA,
  SEND_MESSAGE_SCHEMA,
  SHUTDOWN_SESSION_SCHEMA,
  SPAWN_SESSION_SCHEMA,
  ARCHIVE_PLAN_SHAPE,
  ARCHIVE_PLAN_ARGS_SCHEMA,
  HAND_OFF_SESSION_SHAPE,
  HAND_OFF_SESSION_ARGS_SCHEMA,
  ENTER_WORKTREE_SCHEMA,
  EXIT_WORKTREE_SCHEMA,
  SHUTDOWN_BATON_TEAMMATES_SCHEMA,
} from './schemas';
import { spawnSessionHandler } from './handlers/spawn';
import { sendMessageHandler } from './handlers/send';
import { listSessionsHandler } from './handlers/list';
import { getSessionHandler } from './handlers/get';
import { shutdownSessionHandler } from './handlers/shutdown';
import { archivePlanHandler } from './handlers/archive-plan';
import { handOffSessionHandler } from './handlers/hand-off-session';
import { enterWorktreeHandler } from './handlers/enter-worktree';
import { exitWorktreeHandler } from './handlers/exit-worktree';
import { shutdownBatonTeammatesHandler } from './handlers/shutdown-baton-teammates';

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
   * caller_session_id 覆盖 lazy provider（plan codex-handoff-team-alignment-20260518
   * P2 Step 2.3 / D1 ADR signature 扩展）。
   *
   * 三 transport 行为（**plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 6.2 修订
   * (M7 claude B MED-1 + I2)**：注释精确化 — 生产 3 transport 永不返 null,fallback chain
   * `?? args.caller_session_id` 仅作 test seam 保留兼容,不构成生产代码 dead behavior。
   * 旧描述误把 fallback 当生产语义,reviewer fresh review 反复发为 finding,本注释清晰区分）：
   * - **in-process**：`() => internal.realSessionId ?? tempKey` — realSessionId 可能为 null
   *   但 tempKey 永远是 string（SDK init 起点就分配）,lambda 永远返 string
   * - **HTTP**：`resolveCallerSidForReadOnly` lambda — fallbackToGlobal=true 时 force sentinel,
   *   per-session authn 通过返 real sid,任何其他情况兜底 sentinel(B-HIGH-1 (C) 修法 (c)),
   *   永不返 null
   * - **stdio**：`() => EXTERNAL_CALLER_SENTINEL` — 永远返 sentinel(B-HIGH-1 (C) 修法 (b))
   *
   * `extra` 类型用 `unknown` 保最 conservative；transport-http 那一层 cast 为
   * `{ authInfo?: McpAuthInfo }`。lambda 返 string 表 caller sid（实 sid / sentinel）。
   *
   * **保留 `(...) | null` 外层**：test 文件 tools.test.ts 用 `callerSessionIdOverride: null` 让
   * makeCtx 的 `?? args.caller_session_id` fallback 命中,作为 test seam 注入 args 字段路径
   * （与 transport=http 真实路径仅 fallback 时机不同,行为契约一致）。生产代码无 caller 传 null,
   * fallback chain 在生产是 dead path 但保留 test seam — 不收窄类型避免大幅改 test。
   */
  callerSessionIdOverride: ((extra?: unknown) => string | null) | null;
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
   * HandlerContext。in-process transport 用 closure override 覆盖伪造的 caller_session_id;
   * HTTP transport 通过 mcp-sdk handler 第二参数 extra 透传 RequestHandlerExtra,
   * 由 callerSessionIdOverride 拿 extra.authInfo.resolvedSid 反查（plan P2 Step 2.3）。
   *
   * **fallback chain 现状**（plan §Phase 6.2 注释精确化 — 不删 dead code 仅明确语义）：
   * `?? args.caller_session_id` 在生产 3 transport 是 dead path（lambda 永不返 null,详
   * BuildAgentDeckToolsDeps.callerSessionIdOverride jsdoc）；仅在 test 文件传
   * `callerSessionIdOverride: null` 时命中,作 test seam。Future caller 不应依赖 args
   * 字段命中(B-HIGH-1 (C) 修法已堵伪造路径)。
   */
  function makeCtx(
    args: {
      caller_session_id?: string;
      parent_session_id?: string;
    },
    extra?: unknown,
  ): HandlerContext {
    const overridden = callerSessionIdOverride?.(extra) ?? null;
    const callerSid = overridden ?? args.caller_session_id;
    return {
      caller: makeCallerContext(callerSid, args.parent_session_id, transport),
    };
  }

  const spawnSession = tool(
    AGENT_DECK_TOOL_NAMES.spawnSession,
    'Spawn a new agent session via the given adapter (claude-code / codex-cli). Returns the new sessionId. Subject to depth / per-parent fan-out / per-app rate-limit (see Agent Deck Settings → MCP Server). caller_session_id is required (in-process transport overrides with the real session id).',
    SPAWN_SESSION_SCHEMA,
    async (args, extra) => spawnSessionHandler(args, makeCtx(args, extra)),
    {
      // plan reviewer-codex-cross-adapter-20260519 Phase 0 Step 0.4-tris: codex CLI 内部 mcp tool
      // approval gate 看 mcp annotations 决策放行 vs 走审批 gate (cancel)。给 8 个 write tool
      // 加 spec-compliant annotations 让 codex / 其他 mcp client 都能正确决策。
      // spawn_session: 起 SDK 子进程是应用内 closed-world (主进程 spawn 应用边界内 SDK CLI 子进程,
      // 不是 web search 那种真正外部 open-world); 写 sessions 表 INSERT 不破坏不幂等。
      // **fix v3** (2026-05-20): openWorldHint 由 true 改 false — Phase 0 Step 0.5 方向 B 实测
      // codex CLI 把 openWorldHint:true 当 destructive 触发审批 gate cancel; 改 false 让 codex 放行,
      // spec 上也更准确(应用内部 spawn 不是真正 open world)。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const sendMessage = tool(
    AGENT_DECK_TOOL_NAMES.sendMessage,
    'Send a user message to an existing session. Routes through the universal-message-watcher (DB envelope + cross-adapter dispatch). Returns immediately after queueing. Pass `reply_to_message_id` to link this message into an existing reply chain (the chain is recorded in DB; lead/teammate see the reply auto-injected as a user-role message in their conversation flow — no need to poll). Multi-team callers must specify `team_id`.',
    SEND_MESSAGE_SCHEMA,
    async (args, extra) => sendMessageHandler(args, makeCtx(args, extra)),
    {
      // send_message: 写 messages 表 INSERT(队列入站),不破坏(不删任何东西)、不幂等(重复发会发多条
      // 不同 message)、不与外部世界交互(限项目内 team / session)。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const listSessions = tool(
    AGENT_DECK_TOOL_NAMES.listSessions,
    'List currently visible sessions (read-only). Returns metadata (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, spawnedBy, spawnDepth) — does NOT include events / messages.',
    LIST_SESSIONS_SCHEMA,
    async (args, extra) => listSessionsHandler(args, makeCtx(args, extra)),
    { annotations: { readOnlyHint: true } },
  );

  const getSession = tool(
    AGENT_DECK_TOOL_NAMES.getSession,
    'Get a single session metadata by id. Returns same projection as list_sessions (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, teams, spawnedBy, spawnDepth) — does NOT include events / messages. Returns isError when session does not exist.',
    GET_SESSION_SCHEMA,
    async (args, extra) => getSessionHandler(args, makeCtx(args, extra)),
    { annotations: { readOnlyHint: true } },
  );

  const shutdownSession = tool(
    AGENT_DECK_TOOL_NAMES.shutdownSession,
    'Mark a session as closed (lifecycle=closed) + abort its SDK live query. Does NOT delete events / file_changes / summaries / messages — they remain queryable (lead can still cite closed teammate replies in deep-review aftermath; list_sessions(spawned_by_filter) still finds closed children). team_member soft-exit via left_at; spawn_link kept whole. caller cannot shutdown self.',
    SHUTDOWN_SESSION_SCHEMA,
    async (args, extra) => shutdownSessionHandler(args, makeCtx(args, extra)),
    {
      // shutdown_session: 终止 session lifecycle + abort SDK live query 是破坏性操作(虽然不删
      // events 等子表数据); 重复 shutdown 已 closed session 是 noop 等价 → idempotentHint:true。
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  );

  const archivePlan = tool(
    AGENT_DECK_TOOL_NAMES.archivePlan,
    'Archive a completed plan-driven worktree (K1 hand-off automation): ff-merge worktree branch into base_branch, mv plan file to <main-repo>/plans/<plan_id>.md (status=completed + final_commit + completed_at), **mv `<plan-artifact-dir>/spike-reports/` → `<main-repo>/plans/<plan_id>/spike-reports/` if present** (`<plan-artifact-dir>` = plan file parent + `<plan_id>/`), sync plans/INDEX.md (followup 20260515: 4-column smart update — `appended`/`updated`/`unchanged`/`created`), git commit, then git worktree remove + branch -D. **CHANGELOG_99: also default-archives the caller session** (with K2 baton semantic — plan completion = caller session\'s mission ends since worktree is gone and cwd is invalidated). Caller must ExitWorktree first (mcp tool cannot call CLI internal ExitWorktree; rejects when process.cwd() is inside worktree). Refuses if plan status is already "completed" or worktree is dirty. Returns { archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_action: \'created\'|\'appended\'|\'updated\'|\'unchanged\', final_status, warnings: string[] (followup 20260515 HIGH-2 silent override 等 non-fatal warning,e.g. `.claude/plans/<id>.md` 与 `plans/<id>.md` 同 id 双存覆盖警告;spike-reports mv EXDEV/perm 失败 hint), spike_reports_archived: { src_path, dst_path } | null (null = skip when no spike-reports/ subdir; obj = success), archived: \'ok\' | \'failed\' | \'skipped\' (CHANGELOG_99 caller archive result; \'failed\' is warn-only and does not block ok return) }. deny external caller (high-risk git+fs writes).',
    ARCHIVE_PLAN_SHAPE,
    // plan hand-off-session-adopt-teammates-20260520 Phase 7 reviewer-codex HIGH 修法:
    // tool wrapper closure 跑 ARGS_SCHEMA.safeParse 让 SHAPE-注册路径(SDK / mcp transport)
    // 也实际跑 strict 校验 — 否则 schema 层 unknown keys / refine 守门只在 *.test.ts 显式
    // 调 ARGS_SCHEMA.safeParse 时生效,生产路径漏过 strict 校验。第一道闸门;handler 入口
    // 仍可保留 invariant 防御作第二道。
    async (args, extra) => {
      const parseRes = ARCHIVE_PLAN_ARGS_SCHEMA.safeParse(args);
      if (!parseRes.success) {
        const firstIssue = parseRes.error.issues[0];
        return err(
          `archive_plan args invalid: ${firstIssue?.message ?? 'unknown error'}`,
          JSON.stringify(parseRes.error.issues),
        );
      }
      return archivePlanHandler(parseRes.data, makeCtx(parseRes.data, extra));
    },
    {
      // archive_plan: git ff-merge / mv plan / git commit / git worktree remove / branch -D — 极
      // 破坏性多步 git+fs writes; 重复跑撞 plan status=completed 直接 reject → idempotentHint:false。
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const handOffSession = tool(
    AGENT_DECK_TOOL_NAMES.handOffSession,
    'Start the next SDK session for cross-session hand-off (K2 hand-off automation; **CHANGELOG_99 dual-mode**: plan-driven when `plan_id` is set, generic when omitted). **Plan-driven mode**: read plan frontmatter to derive worktree_path, validate status=in_progress, spawn a new session with cwd=mainRepo (default; CHANGELOG_99 cwd resilience) and auto-constructed cold-start prompt "按 <plan-abs-path> 接力" (optional phase_label appended). **Generic mode** (no plan_id): caller passes `prompt` (defaults to "从上一个会话接力继续工作") and default cwd = caller session cwd; lets any session baton off to a new SDK session without plan/worktree prereq. **Baton semantic (CHANGELOG_97)**: by default does NOT join any team (no lead/teammate role assigned to caller / new session) AND auto-archives the caller session after spawn — the new session takes over independently while the caller exits. Pass team_name explicitly only if you want lead/teammate communication. **CHANGELOG_99 cwd resilience (plan-driven mode)**: default cwd is mainRepo (was worktreePath; changed so new session sessionRepo.cwd survives `archive_plan` / `git worktree remove`). New session expected to run `EnterWorktree(path: worktreePath)` itself per user CLAUDE.md §Step 3. Fallback chain: caller args.cwd > resolved.mainRepo > resolved.worktreePath. Defaults: adapter=claude-code, plan file path resolved from caller cwd via git rev-parse → <main-repo>/.claude/plans/<plan_id>.md, fallback ~/.claude/plans/<plan_id>.md. Returns { mode: \'plan\' | \'generic\', planId, planFilePath, worktreePath, baseBranch, phaseLabel, initialPrompt, ignoredFields: string[] (generic mode warns when caller passed plan-only fields like phase_label / plan_file_path — ignored not error), sessionId, adapter, cwd, teamId (null when no team_name), teamName (null), spawnDepth, sentAt, spawnPromptMessageId (null), archived }. Caller archive failure is warn-only (does not block ok return). deny external caller (SDK session fork bomb risk).',
    HAND_OFF_SESSION_SHAPE,
    // plan hand-off-session-adopt-teammates-20260520 Phase 7 reviewer-codex HIGH 修法:同 archive_plan
    // — tool wrapper closure 跑 HAND_OFF_SESSION_ARGS_SCHEMA.safeParse 让生产 SHAPE-注册路径
    // 也实际跑 strict + N2.c refine 校验。修前 SHAPE 注册的 SDK / mcp transport 不跑 .strict()
    // 也不跑 .refine(),user 同传 {adopt_teammates: true, team_name: 'X'} schema 不 reject →
    // handler 透传 args.team_name 给 spawn → spawn batonRole='lead' 写 newSid 入 team X →
    // swapLead 之后形成 dual-lead window 破坏 N1 invariant + silent prompt 数据丢失。
    async (args, extra) => {
      const parseRes = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse(args);
      if (!parseRes.success) {
        const firstIssue = parseRes.error.issues[0];
        return err(
          `hand_off_session args invalid: ${firstIssue?.message ?? 'unknown error'}`,
          JSON.stringify(parseRes.error.issues),
        );
      }
      return handOffSessionHandler(parseRes.data, makeCtx(parseRes.data, extra));
    },
    {
      // hand_off_session: 起 SDK 子进程同 spawn_session 是应用内 closed-world; 默认 archive_caller=true
      // 归档 caller (destructiveHint:true,会 close 当前 caller session); 重复 hand-off 起 N 个新
      // session → idempotentHint:false。
      // **fix v3** (2026-05-20): openWorldHint 由 true 改 false — 与 spawn_session 同款修订(详上)。
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  // plan codex-handoff-team-alignment-20260518 P1 Step 1.3：mcp 版 enter_worktree / exit_worktree
  // 给 codex / 跨 adapter caller 提供 claude builtin EnterWorktree / ExitWorktree 的等价能力。
  // 不取代 claude builtin（claude SDK session 仍首选 builtin），仅作补充让跨 adapter caller
  // 走 archive_plan 预检 4 态分流时认得跨 adapter 路径（详 P1 Step 1.4 archive-plan-impl.ts）。
  const enterWorktree = tool(
    AGENT_DECK_TOOL_NAMES.enterWorktree,
    'Create a new git worktree at `<main-repo>/.claude/worktrees/<plan_id>/` (or caller-overridden path) with branch `worktree-<plan_id>`, based on HEAD by default (resolution chain: args.base_commit > args.base_branch > plan frontmatter.base_commit > plan frontmatter.base_branch > HEAD). Sets `sessions.cwd_release_marker = <worktree_path>` for the caller session so that `archive_plan` preflight 4-state dispatch recognizes the cross-adapter path (state 2: in worktree + marker == worktree_path → pass). Uses explicit `git worktree add -b <branch> <path> <base_commit>` (avoids claude builtin EnterWorktree v2.1.112 stale base bug — see user CLAUDE.md §Step 1 末 callout). Returns { worktreePath, branchName, baseCommit, baseSource: arg-base-commit|arg-base-branch|frontmatter-base-commit|frontmatter-base-branch|head, markerSet }. Refuses if worktree path or branch already exists (no silent reuse). deny external caller (git write + per-session marker write).',
    ENTER_WORKTREE_SCHEMA,
    async (args, extra) => enterWorktreeHandler(args, makeCtx(args, extra)),
    {
      // enter_worktree: 创新 git worktree dir + branch (不破坏现有, refuses if path/branch
      // already exists 走 reject 路径); 重复跑同 plan_id 撞 reject → idempotentHint:false。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const exitWorktree = tool(
    AGENT_DECK_TOOL_NAMES.exitWorktree,
    'Exit a git worktree previously entered via enter_worktree (or claude builtin EnterWorktree if caller manually set cwd_release_marker). Two actions: action="keep" leaves worktree directory + branch intact (typical mid-plan hand-off scenario, new session can re-enter via EnterWorktree(path: ...)); action="remove" deletes worktree + branch (typical plan completion / abandon cleanup). Both actions clear `sessions.cwd_release_marker` for the caller session. Worktree path resolution: args.worktree_path > caller sessionRepo.cwd_release_marker. action="remove" preflights worktree is clean (refuses if dirty unless discard_changes=true). Returns { worktreePath, action, branchDeleted, worktreeRemoved, markerCleared }. Refuses cross-worktree exit (args.worktree_path mismatches caller marker — stale state). deny external caller (git write + per-session marker clear).',
    EXIT_WORKTREE_SCHEMA,
    async (args, extra) => exitWorktreeHandler(args, makeCtx(args, extra)),
    {
      // exit_worktree: action=keep 不破坏(只 clear cwd marker), action=remove 真删 git worktree
      // dir + branch -D 是破坏性 → 整体保守 destructiveHint:true。重复 exit 撞 marker not set
      // 走 reject → idempotentHint:false。
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  // plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.3 / D4 F1c：
  // shutdown_baton_teammates tool — escape hatch 让 caller 手工归档 plan 后补跑 baton-cleanup
  // phase 1（仅 teammate shutdown，不归档 caller）。
  const shutdownBatonTeammates = tool(
    AGENT_DECK_TOOL_NAMES.shutdownBatonTeammates,
    'Escape hatch: shutdown all active teammates of every team where caller is the lead — equivalent of `archive_plan` / `hand_off_session` baton-cleanup phase 1, **without** archiving caller (phase 2). Use this ONLY when archive_plan tool precheck failed (mainRepo dirty on archive-critical paths / cwd resilience guard / etc.) and you went the user CLAUDE.md §Step 4 manual archive 5-step path (commit + mv + git worktree remove + branch -D), bypassing archive_plan tool — then runBatonCleanup phase 1 was never invoked → reviewer-claude / reviewer-codex teammates naturally decay to dormant but stay un-closed (memory + SDK live query waste). This tool restores the baton-cleanup teammate-shutdown semantic. Behavior: dedup teammate sids across multi-team shared sids → serial close → handle individual close failures (warn, continue). **Important error contract** (plan §F1c R2 codex MED-4): if caller is not a lead in any active team (caller is teammate / no active membership / all caller-lead teams already archived), returns ERROR with hint pointing to IPC TeamShutdownAllTeammates handler or UI Team panel — NOT silent success (that would mislead caller into believing cleanup happened). deny external caller (sessionManager.close write + per-session caller=lead lookup needs real caller_session_id). Returns { closed: string[], failed: Array<{sessionId,reason}>, skipped: null, planId: string | null }.',
    SHUTDOWN_BATON_TEAMMATES_SCHEMA,
    async (args, extra) => shutdownBatonTeammatesHandler(args, makeCtx(args, extra)),
    {
      // shutdown_baton_teammates: 终止所有 caller-lead team 的 active teammates 是破坏性 (close
      // sessions + abort SDK live queries); 重复跑已 closed teammates 是 noop 等价 →
      // idempotentHint:true。
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  );

  return [
    spawnSession,
    sendMessage,
    listSessions,
    getSession,
    shutdownSession,
    archivePlan,
    handOffSession,
    enterWorktree,
    exitWorktree,
    shutdownBatonTeammates,
  ];
}
