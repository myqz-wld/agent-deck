/**
 * Agent Deck MCP server 的 18 个 in-process tool 注册 facade（B'0 ADR §3；10 现有 + 5 task + 3 issue —
 * plan task-mcp-merge-into-agent-deck-mcp-20260521 合并 task-manager + issue-tracker-mcp-20260529 加 2 issue tool
 * + 体验改进 20260531 §需求3 加 update_issue_status 后）。
 *
 * 三 transport（in-process / HTTP / stdio）共享同一份 buildAgentDeckTools 输出；
 * transport 层负责 caller-id 注入策略：
 * - in-process（B'3）：closure 强制覆盖 args.callerSessionId（防 prompt 注入伪造）
 * - HTTP/stdio：args.callerSessionId 必填，handler 内反查 sessionManager
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
 *   replyToMessageId；reply 不再被
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
  TASK_CREATE_SCHEMA,
  TASK_LIST_SCHEMA,
  TASK_GET_SCHEMA,
  TASK_UPDATE_SCHEMA,
  TASK_DELETE_SCHEMA,
  REPORT_ISSUE_SCHEMA,
  APPEND_ISSUE_CONTEXT_SCHEMA,
  UPDATE_ISSUE_STATUS_SCHEMA,
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
import { taskCreateHandler } from './handlers/task-create';
import { taskListHandler } from './handlers/task-list';
import { taskGetHandler } from './handlers/task-get';
import { taskUpdateHandler } from './handlers/task-update';
import { taskDeleteHandler } from './handlers/task-delete';
import { reportIssueHandler } from './handlers/report-issue';
import { appendIssueContextHandler } from './handlers/append-issue-context';
import { updateIssueStatusHandler } from './handlers/update-issue-status';

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
   * callerSessionId 覆盖 lazy provider（plan codex-handoff-team-alignment-20260518
   * P2 Step 2.3 / D1 ADR signature 扩展）。
   *
   * 三 transport 行为（**plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 6.2 修订
   * (M7 claude B MED-1 + I2)**：注释精确化 — 生产 3 transport 永不返 null,fallback chain
   * `?? args.callerSessionId` 仅作 test seam 保留兼容,不构成生产代码 dead behavior。
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
   * makeCtx 的 `?? args.callerSessionId` fallback 命中,作为 test seam 注入 args 字段路径
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
   * 把 zod 解析后的 args 字段（含 callerSessionId / parentSessionId）规范成
   * HandlerContext。in-process transport 用 closure override 覆盖伪造的 callerSessionId;
   * HTTP transport 通过 mcp-sdk handler 第二参数 extra 透传 RequestHandlerExtra,
   * 由 callerSessionIdOverride 拿 extra.authInfo.resolvedSid 反查（plan P2 Step 2.3）。
   *
   * **fallback chain 现状**（plan §Phase 6.2 注释精确化 — 不删 dead code 仅明确语义）：
   * `?? args.callerSessionId` 在生产 3 transport 是 dead path（lambda 永不返 null,详
   * BuildAgentDeckToolsDeps.callerSessionIdOverride jsdoc）；仅在 test 文件传
   * `callerSessionIdOverride: null` 时命中,作 test seam。Future caller 不应依赖 args
   * 字段命中(B-HIGH-1 (C) 修法已堵伪造路径)。
   */
  function makeCtx(
    args: {
      callerSessionId?: string;
      parentSessionId?: string;
    },
    extra?: unknown,
  ): HandlerContext {
    const overridden = callerSessionIdOverride?.(extra) ?? null;
    const callerSid = overridden ?? args.callerSessionId;
    return {
      caller: makeCallerContext(callerSid, args.parentSessionId, transport),
    };
  }

  const spawnSession = tool(
    AGENT_DECK_TOOL_NAMES.spawnSession,
    'Spawn a new agent session via the given adapter (claude-code / codex-cli). Returns the new sessionId. Pass teamName to form a team (caller becomes lead, new session joins as teammate) so the two can send_message each other; omit for a standalone session. Subject to depth / per-parent fan-out / per-app rate-limit (see Agent Deck Settings → MCP Server). SDK-internal callers do NOT pass callerSessionId — the in-process transport auto-injects the real session id; only external HTTP/stdio callers must pass it.',
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
    'Send a user message to an existing session. Routes through the universal-message-watcher (DB envelope + cross-adapter dispatch). Returns immediately after queueing. Pass `replyToMessageId` to link this message into an existing reply chain (the chain is recorded in DB; lead/teammate see the reply auto-injected as a user-role message in their conversation flow — no need to poll). Specify `teamId` only when caller and target share more than one active team (auto-resolved when they share exactly one).',
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
    'List currently visible sessions (read-only). Returns metadata (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, teams [{teamId, teamName, role}], spawnedBy, spawnDepth) — does NOT include events / messages. Use the teams[].teamId when you need a teamId for send_message (no need to call get_session per session).',
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
    'Mark a session as closed (lifecycle=closed) + abort its SDK live query. Does NOT delete events / file_changes / summaries / messages — they remain queryable (lead can still cite closed teammate replies in deep-review aftermath; list_sessions(spawnedByFilter) still finds closed children). team_member soft-exit via left_at; spawn_link kept whole. caller cannot shutdown self.',
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
    'Archive a completed plan-driven worktree (K1 hand-off automation): ff-merge worktree branch into baseBranch, mv plan file to <main-repo>/ref/plans/<planId>.md (status=completed + final_commit + completed_at), **mv `<plan-artifact-dir>/spike-reports/` → `<main-repo>/ref/plans/<planId>/spike-reports/` if present** (`<plan-artifact-dir>` = plan file parent + `<planId>/`), sync ref/plans/INDEX.md (followup 20260515: 4-column smart update — `appended`/`updated`/`unchanged`/`created`), git commit, then git worktree remove + branch -D. **CHANGELOG_99: also default-archives the caller session** (with K2 baton semantic — plan completion = caller session\'s mission ends since worktree is gone and cwd is invalidated). Caller must ExitWorktree first (mcp tool cannot call CLI internal ExitWorktree; rejects when the caller session cwd / held cwd_release_marker is inside the worktree — use ExitWorktree, not a shell `cd`). Refuses if plan status is already "completed" or worktree is dirty. Returns { archivedPath, commitHash, branchDeleted, worktreeRemoved, plansIndexAction: \'created\'|\'appended\'|\'updated\'|\'unchanged\', finalStatus, warnings: string[] (followup 20260515 HIGH-2 silent override 等 non-fatal warning,e.g. `.claude/plans/<id>.md` 与 `ref/plans/<id>.md` 同 id 双存覆盖警告;spike-reports mv EXDEV/perm 失败 hint), spikeReportsArchived: { srcPath, dstPath } | null (null = skip when no spike-reports/ subdir; obj = success), archived: \'ok\' | \'failed\' | \'skipped\' (CHANGELOG_99 caller archive result; \'failed\' is warn-only and does not block ok return) }. deny external caller (high-risk git+fs writes).',
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
    'Start the next SDK session for cross-session hand-off (K2 hand-off automation; **CHANGELOG_99 dual-mode**: plan-driven when `planId` is set, generic when omitted). **Plan-driven mode**: read plan frontmatter to derive worktreePath, validate status=in_progress, spawn a new session with cwd=mainRepo (default; CHANGELOG_99 cwd resilience) and auto-constructed cold-start prompt "按 <plan-abs-path> 接力" (optional phaseLabel appended). **Generic mode** (no planId): caller passes `prompt` (defaults to "从上一个会话接力继续工作") and default cwd = caller session cwd; lets any session baton off to a new SDK session without plan/worktree prereq. **Baton semantic (CHANGELOG_97)**: by default does NOT join any team (no lead/teammate role assigned to caller / new session) AND auto-archives the caller session after spawn — the new session takes over independently while the caller exits. Pass teamName explicitly only if you want lead/teammate communication. **CHANGELOG_99 cwd resilience (plan-driven mode)**: default cwd is mainRepo (was worktreePath; changed so new session sessionRepo.cwd survives `archive_plan` / `git worktree remove`). New session expected to run `EnterWorktree(path: worktreePath)` itself per user CLAUDE.md §Step 3. Fallback chain: caller args.cwd > resolved.mainRepo > resolved.worktreePath. Defaults: adapter=claude-code, plan file path resolved from caller cwd via git rev-parse → <main-repo>/.claude/plans/<planId>.md, fallback <main-repo>/ref/plans/<planId>.md, then ~/.claude/plans/<planId>.md. **Task ownership reassignment** (plan task-mcp-owner-session-id-rewrite-20260521 v023 §D3 + plan task-team-id-restore-20260525 v024 §D4): with default `archiveCaller=true`, all tasks owned by caller are atomically processed by the new session per `teamTaskPolicy` (default `\'clear-team\'`), so tasks survive the baton — owner.session FK CASCADE would otherwise delete them. **`teamTaskPolicy` 三态** (v024): `\'clear-team\'` (default) UPDATE owner + teamId=NULL 过继 ownership 同时清 teamId 变 personal (保最大兼容性 newSid 拿到的 task 都可写); `\'preserve-team\'` UPDATE owner 不动 teamId (caller 自负保证 adoptTeammates=true 让 newSid 接管 team 当 lead, 否则撞 D3 写权限 reject — handler 加 policyWarning 暴露根因); `\'skip\'` 单 transaction 4 步原子化 — DELETE caller owned team task (teamId IS NOT NULL) + cleanup blocks/blockedBy 引用 + reassign 剩余 personal task to newSid + handler commit 后 per-id safeEmit task-changed deleted events. **archiveCaller=false 优先级** (v024 §D4): `archiveCaller=false` 时 reassign 整段被 skip (caller 仍 active 继续 own 自己 task), `teamTaskPolicy` 不执行 — `taskReassignment={status:\'skipped\', reason:\'archive-caller-false\', policy: <resolvedPolicy>}` (policy 字段仍透传 advisory). **preserve-team 错配 soft warning** (v024 §D4 + Round 4 HIGH-1): caller 显式 `teamTaskPolicy=\'preserve-team\'` 时, reassign 之前 snapshot caller owned distinct teamId, 与 newSid handoff 后 active teams (`adopted.adoptedTeamIds` ∪ `spawnData.teamId`) 比对差集; 差集非空 → `taskReassignment.policyWarning=\'preserve-team-unadopted-teams\'` + `taskReassignment.unadoptedTeamIds: string[]` 字段含差集 teamId 列表 (preserve-team policy + 差集 teamId 列表: newSid 没成为 lead 的 team, 这些 team 的 task 仍归 newSid 但 newSid 不是 active member 无人可写; caller 应据此决定是否 retry adopt 或接受降级让 task 处于 unreachable 状态). Status surfaced in ok return `taskReassignment` field — `\'ok\'+count+policy[+policyWarning+unadoptedTeamIds]` / `\'failed\'+error+policy` / `\'skipped\'+reason+policy` (`policy` field required on all 3 statuses per v024 §不变量 5). Returns { mode: \'plan\' | \'generic\', planId, planFilePath, worktreePath, baseBranch, phaseLabel, initialPrompt, ignoredFields: string[] (generic mode warns when caller passed plan-only fields like phaseLabel / planFilePath — ignored not error), sessionId, adapter, cwd, teamId (null when no teamName), teamName (null), spawnDepth, sentAt, spawnPromptMessageId (null), archived, adopted: { preserved, failed, teamsTotal, teamsAdopted, firstTeamId, adoptedTeamIds: string[] (v024 §Step D2: swapLead 成功的 caller-as-lead team uuids,与 preserved teammate sids 对称暴露便于 caller diag policyWarning 来源) } | null, taskReassignment }. Caller archive failure is warn-only (does not block ok return). deny external caller (SDK session fork bomb risk).',
    HAND_OFF_SESSION_SHAPE,
    // plan hand-off-session-adopt-teammates-20260520 Phase 7 reviewer-codex HIGH 修法:同 archive_plan
    // — tool wrapper closure 跑 HAND_OFF_SESSION_ARGS_SCHEMA.safeParse 让生产 SHAPE-注册路径
    // 也实际跑 strict + N2.c refine 校验。修前 SHAPE 注册的 SDK / mcp transport 不跑 .strict()
    // 也不跑 .refine(),user 同传 {adoptTeammates: true, teamName: 'X'} schema 不 reject →
    // handler 透传 args.teamName 给 spawn → spawn batonRole='lead' 写 newSid 入 team X →
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
      // hand_off_session: 起 SDK 子进程同 spawn_session 是应用内 closed-world; 默认 archiveCaller=true
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
    'Create a new git worktree at `<main-repo>/.claude/worktrees/<planId>/` (or caller-overridden path) with branch `worktree-<planId>`, based on HEAD by default (resolution chain: args.baseCommit > args.baseBranch > plan frontmatter.base_commit > plan frontmatter.base_branch > HEAD). Sets `sessions.cwd_release_marker = <worktreePath>` for the caller session so that `archive_plan` preflight 4-state dispatch recognizes the cross-adapter path (state 2: in worktree + marker == worktreePath → pass). Uses explicit `git worktree add -b <branch> <path> <baseCommit>` (avoids claude builtin EnterWorktree v2.1.112 stale base bug — see user CLAUDE.md §Step 1 末 callout). Returns { worktreePath, branchName, baseCommit, baseSource: arg-base-commit|arg-base-branch|frontmatter-base-commit|frontmatter-base-branch|head, markerSet }. Refuses if worktree path or branch already exists (no silent reuse). **This tool CREATES a worktree and does NOT change the calling session cwd** — after it returns, operate on worktree files via absolute paths or `git -C <worktreePath>` (codex has no native cd; Claude may use builtin EnterWorktree(path:) to actually switch cwd). To resume an EXISTING worktree do NOT call this tool (it refuses existing paths) — use `git -C <worktreePath>` / absolute paths directly. deny external caller (git write + per-session marker write).',
    ENTER_WORKTREE_SCHEMA,
    async (args, extra) => enterWorktreeHandler(args, makeCtx(args, extra)),
    {
      // enter_worktree: 创新 git worktree dir + branch (不破坏现有, refuses if path/branch
      // already exists 走 reject 路径); 重复跑同 planId 撞 reject → idempotentHint:false。
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
    'Exit a git worktree previously entered via enter_worktree (or claude builtin EnterWorktree if caller manually set cwd_release_marker). Two actions: action="keep" leaves worktree directory + branch intact (typical mid-plan hand-off scenario, new session can re-enter via EnterWorktree(path: ...)); action="remove" deletes worktree + branch (typical plan completion / abandon cleanup). Both actions clear `sessions.cwd_release_marker` for the caller session. Worktree path resolution: args.worktreePath > caller sessionRepo.cwd_release_marker. action="remove" preflights worktree is clean (refuses if dirty unless discardChanges=true). Returns { worktreePath, action, branchDeleted, worktreeRemoved, markerCleared }. Refuses cross-worktree exit (args.worktreePath mismatches caller marker — stale state). deny external caller (git write + per-session marker clear).',
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
    'Escape hatch: shutdown all active teammates of every team where caller is the lead — equivalent of `archive_plan` / `hand_off_session` baton-cleanup phase 1, **without** archiving caller (phase 2). Use this ONLY when archive_plan tool precheck failed (mainRepo dirty on archive-critical paths / cwd resilience guard / etc.) and you went the user CLAUDE.md §Step 4 manual archive 5-step path (commit + mv + git worktree remove + branch -D), bypassing archive_plan tool — then runBatonCleanup phase 1 was never invoked → reviewer-claude / reviewer-codex teammates naturally decay to dormant but stay un-closed (memory + SDK live query waste). This tool restores the baton-cleanup teammate-shutdown semantic. Behavior: dedup teammate sids across multi-team shared sids → serial close → handle individual close failures (warn, continue). **Important error contract** (plan §F1c R2 codex MED-4): if caller is not a lead in any active team (caller is teammate / no active membership / all caller-lead teams already archived), returns ERROR with hint pointing to IPC TeamShutdownAllTeammates handler or UI Team panel — NOT silent success (that would mislead caller into believing cleanup happened). deny external caller (sessionManager.close write + per-session caller=lead lookup needs real callerSessionId). Returns { closed: string[], failed: Array<{sessionId,reason}>, skipped: null, planId: string | null }.',
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

  // plan task-mcp-merge-into-agent-deck-mcp-20260521：5 个 task tool 合并入 agent-deck-mcp
  // namespace（工具名从 mcp__tasks__task_* 切到 mcp__agent-deck__task_*，breaking change）。
  // R3-claude-LOW-1：用 plain SHAPE 注册（与 8 个 simple tool 同款，不走 archive_plan /
  // hand_off_session 的 ARGS_SCHEMA.safeParse-wrapper pattern — task tools 无 .strict() /
  // .refine() invariant 需 production 真跑校验）。
  // R1 F3 + R2 F-R2-1：annotations 4-tuple 显式标 — task_delete idempotentHint:false 与现状
  // contract 对齐（not-found 返 isError 不是 noop）。
  const taskCreate = tool(
    AGENT_DECK_TOOL_NAMES.taskCreate,
    `Create a structured task in the agent-deck task store. owner_session_id is auto-derived from callerSessionId. Personal task by default (omit teamId — note: task_create rejects an explicit null, just leave the field out) — visible & writable only to owner. Pass teamId to bind task to a team — caller must be active member of that team (agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL). Returns the created task with auto-generated id.`,
    TASK_CREATE_SCHEMA,
    async (args, extra) => taskCreateHandler(args, makeCtx(args, extra)),
    {
      // task_create: 写 tasks 表 INSERT 不破坏不幂等（重复 create 多条不同 task）；
      // 不与外部世界交互（限项目内 task store）。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const taskList = tool(
    AGENT_DECK_TOOL_NAMES.taskList,
    `List tasks visible to the current session. Default scope (teamIdFilter omitted): caller-owned personal tasks ∪ team-bound tasks where caller is active member of task.teamId (archived teams excluded). Pass teamIdFilter='<uuid>' to restrict to one team (caller must be active member). Pass teamIdFilter='null-personal' to restrict to caller's own personal tasks. Returns { total, hasMore, tasks: [...] } where total = tasks.length on current page (post-LIMIT/OFFSET) and hasMore signals more results may exist (tasks.length === limit). Default limit=100, max 500.`,
    TASK_LIST_SCHEMA,
    async (args, extra) => taskListHandler(args, makeCtx(args, extra)),
    {
      // task_list: 只读，不破坏不与外部世界交互；幂等（多次相同 args 调用返同结果）。
      // F4 fix (deep-review-changelog146-20260524 R1 claude LOW): 与 task_create / task_update /
      // task_delete 三 write tool 4-tuple 对称，避免 MCP client（codex CLI approval gate /
      // claude CLI 渲染）按 undefined 字段走默认兜底（部分 client 把 undefined 当 true）。
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  );

  const taskGet = tool(
    AGENT_DECK_TOOL_NAMES.taskGet,
    'Get a single task by id, scoped to caller team membership (team-bound task: caller must be active member; personal task: caller must be owner). Deny external caller (EXTERNAL_CALLER_ALLOWED.task_get=false).',
    TASK_GET_SCHEMA,
    async (args, extra) => taskGetHandler(args, makeCtx(args, extra)),
    {
      // task_get: 只读 + 幂等，4-tuple 对称（F4 修法说明同 task_list）。
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  );

  const taskUpdate = tool(
    AGENT_DECK_TOOL_NAMES.taskUpdate,
    `Incrementally update a task, scoped to caller team membership. Team-bound task (teamId != null): caller must be active member of task.teamId (regardless of owner). Personal task (teamId IS NULL): caller must be owner. Omitted fields are left unchanged. Pass null to clear nullable fields (description, activeForm). Pass teamId=null to convert to personal; pass teamId='<uuid>' to bind to a team (caller must be active member of new team). updated_at is auto-refreshed.`,
    TASK_UPDATE_SCHEMA,
    async (args, extra) => taskUpdateHandler(args, makeCtx(args, extra)),
    {
      // task_update: 写 tasks 表 UPDATE 不破坏不幂等（重复 update 状态值会重复改但语义稳定）；
      // 不与外部世界交互。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const taskDelete = tool(
    AGENT_DECK_TOOL_NAMES.taskDelete,
    `Delete a task by id, scoped to caller team membership. Team-bound task (teamId != null): caller must be active member of task.teamId. Personal task (teamId IS NULL): caller must be owner. With force=true, recursively delete all downstream tasks listed in blocks (each downstream is also write-permission-checked by teamId: tasks the caller cannot write are skipped, not deleted). Without force, surviving tasks have their blocks/blockedBy references to it cleaned up.`,
    TASK_DELETE_SCHEMA,
    async (args, extra) => taskDeleteHandler(args, makeCtx(args, extra)),
    {
      // task_delete: 真删 task + cascade 下游是破坏性；R2 F-R2-1：idempotentHint:false
      // 与现状 contract 对齐（not-found 返 isError 不是 noop —— 与 archive_plan idempotentHint:false
      // 同款；不像 shutdown_session 已 closed noop 等价）。
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  // plan issue-tracker-mcp-20260529 §Step 3.3.5 + 体验改进 20260531 §需求3：3 个 issue write tool。
  // report_issue / append_issue_context 仍是「只写不查」（**没有** issue_list / issue_get / issue_delete —
  // read/admin 走 IPC channels 给 UI 端）；update_issue_status 是受控开口让源 / 解决会话自助推进 status。
  // annotations 与 task_create 同款（写表 INSERT 非破坏不幂等不外联）。
  const reportIssue = tool(
    AGENT_DECK_TOOL_NAMES.reportIssue,
    `Report a new issue from this SDK session (agent execution problem tracker). **agent write-only for reporting** (§不变量 1): no list/get/delete tools — UI is responsible for read/admin via IPC channels (the only status-write opening is update_issue_status for the source/resolution session). \`sourceSessionId\` is closure-injected from callerSessionId (§不变量 3 source = owner). Returns the full IssueRecord — its primary key field is \`id\` (NOT \`issueId\`); pass that \`id\` as the \`issueId\` arg of follow-up append_issue_context / update_issue_status calls in the same session. Defaults: kind="follow-up" (soft enum + free-form fallback — non-enum values stored as-is, UI groups under "other"; recommended values: "follow-up" / "app-bug"), severity="medium" (strict enum low/medium/high), cwd fallback chain: args.cwd > caller session cwd > null. \`logsRef\` is a reference (not log content) — see logsRef schema for {date YYYY-MM-DD, tsRange?, scopes?, note?} structure; UI renders as pointer to runtime-logging plan log files.`,
    REPORT_ISSUE_SCHEMA,
    async (args, extra) => reportIssueHandler(args, makeCtx(args, extra)),
    {
      // report_issue: 写 issues 表 INSERT，不破坏不幂等（重复 report 多条不同 issue）；
      // 不与外部世界交互（限项目内 issue tracker）。与 task_create 同款 4-tuple。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const appendIssueContext = tool(
    AGENT_DECK_TOOL_NAMES.appendIssueContext,
    `Append additional context to an issue YOU previously reported in this same session. **Strict source-bound** (§D10 / §不变量 3): rejects if \`issue.sourceSessionId !== callerSessionId\` (cross-session / cross-caller / hand_off after losing issueId → use report_issue to create a new issue, UI will manually merge). **Rejects if status='resolved'** (§D7): resolved issues don't accept appends; the source/resolution session can flip status back via update_issue_status (or UI can), then append again. Append does NOT modify \`issues.description\` (§不变量 9): new content goes to \`issue_appendices\` subtable (immutable from agent perspective; UI renders read-only); optional \`logsRef\` merged into \`issues.logs_ref\` per §D17 (date overwrite / tsRange min-max extend / scopes union+dedup / note append-then-truncate-from-head). Returns the full IssueRecord including the updated \`appendices\` list (so UI can emit 'issue-changed' kind='appended' with full record — no separate IPC fetch needed §D19).`,
    APPEND_ISSUE_CONTEXT_SCHEMA,
    async (args, extra) => appendIssueContextHandler(args, makeCtx(args, extra)),
    {
      // append_issue_context: 写 issue_appendices 表 INSERT + 可选 issues.logs_ref UPDATE，不破坏
      // 不幂等（重复 append 累积多行 + logsRef merge 算法非幂等）；不与外部世界交互。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  // plan issue-tracker 体验改进 20260531 §需求3：受控开口让源 / 解决会话自助推进 status
  // （打破旧「agent 永不改 status」铁律）。授权边界 source OR resolution session;可选 note 留痕。
  const updateIssueStatus = tool(
    AGENT_DECK_TOOL_NAMES.updateIssueStatus,
    `Update the status of an issue YOU are responsible for — authorized only when the caller is the issue's **source session** (the one that report_issue'd it) OR its **resolution session** (the session UI「起新会话解决」spawned to fix it). Use this to self-resolve an issue you fixed (status='resolved') or reopen one (status='open' / 'in-progress') without a human touching the UI. Third-party callers (neither source nor resolution) are rejected. Optional \`note\` (1-2000 chars) is recorded as an appendix for traceability (how it was fixed / why reopened). Rejects soft-deleted issues. Returns the full IssueRecord (with appendices) and emits 'issue-changed' kind='updated' so the UI refreshes live. deny external caller.`,
    UPDATE_ISSUE_STATUS_SCHEMA,
    async (args, extra) => updateIssueStatusHandler(args, makeCtx(args, extra)),
    {
      // update_issue_status: 写 issues.status UPDATE（+ 可选 appendix INSERT）。破坏性低但改状态机
      // （进 resolved 触发 GC 倒计时）→ destructiveHint:false 但 idempotentHint:false（note 每次累积新
      // appendix；重复设同 status 本身幂等但 note 非幂等）。不与外部世界交互。
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
    taskCreate,
    taskList,
    taskGet,
    taskUpdate,
    taskDelete,
    reportIssue,
    appendIssueContext,
    updateIssueStatus,
  ];
}
