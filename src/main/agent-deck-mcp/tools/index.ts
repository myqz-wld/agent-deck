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
  HAND_OFF_SESSION_SHAPE,
  HAND_OFF_SESSION_ARGS_SCHEMA,
  ENTER_WORKTREE_SCHEMA,
  EXIT_WORKTREE_SCHEMA,
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
import { handOffSessionHandler } from './handlers/hand-off-session';
import { enterWorktreeHandler } from './handlers/enter-worktree';
import { exitWorktreeHandler } from './handlers/exit-worktree';
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
    'Spawn a new agent session via the given adapter (claude-code / deepseek-claude-code / codex-cli). Returns the new sessionId. Put full task context in prompt; for long context, write a file under /tmp and tell the spawned session to read it. Pass teamName to form a team (caller becomes lead, new session joins as teammate) so the two can send_message each other; omit for a standalone session. Subject to depth / per-parent fan-out / per-app rate-limit (see Agent Deck Settings → MCP Server). SDK-internal callers do NOT pass callerSessionId — the in-process transport auto-injects the real session id; only external HTTP/stdio callers must pass it.',
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
    'Send a user message to an existing session. Routes through the universal-message-watcher (DB envelope + cross-adapter dispatch). Returns immediately after queueing. Works with or without a shared team: if caller and target share an active team the message is team-scoped; if they share none it is delivered as a teamless DM (still injected into the target session\'s conversation, just not shown in a team panel). Pass `replyToMessageId` to link this message into an existing reply chain (the chain is recorded in DB; lead/teammate see the reply auto-injected as a user-role message in their conversation flow — no need to poll). Specify `teamId` only when caller and target share more than one active team (auto-resolved when they share exactly one; rejected if the passed teamId is not a shared active team).',
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

  const handOffSession = tool(
    AGENT_DECK_TOOL_NAMES.handOffSession,
    'Hand off the current SDK session to a fresh successor session. Provide the full cold-start text in `prompt`; include any plan file path, /tmp context file path, and next action directly in that text. The tool transfers caller-owned resources (tasks, active team memberships, worktree marker) to the successor and closes the caller only after mandatory transfer succeeds; transfer failure returns an error and keeps the caller active. Use spawn_session for parallel work. Returns the spawn_session fields plus { initialPrompt, callerClosed, resourceTransfer } on success. deny external caller.',
    HAND_OFF_SESSION_SHAPE,
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  const enterWorktree = tool(
    AGENT_DECK_TOOL_NAMES.enterWorktree,
    'Create a fresh git worktree from a required local baseBranch. The tool resolves refs/heads/<baseBranch> to a commit, creates a new workBranch from that exact branch version, records the caller worktree marker, and returns { worktreePath, workBranch, baseBranch, baseCommit, baseSource, markerSet }. It does not change the SDK session cwd; use absolute paths or git -C <worktreePath>. deny external caller.',
    ENTER_WORKTREE_SCHEMA,
    async (args, extra) => enterWorktreeHandler(args, makeCtx(args, extra)),
    {
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
    'Clean up the worktree directory owned by the caller marker or by an explicit worktreePath. It refuses dirty worktrees unless discardChanges=true; do not discard until user work is saved, committed, or intentionally abandoned. By default the work branch is kept so committed changes are not lost; pass deleteBranch=true only after the work is merged, cherry-picked, or intentionally abandoned. Returns { worktreePath, workBranch, branchDeleted, worktreeRemoved, markerCleared }. deny external caller.',
    EXIT_WORKTREE_SCHEMA,
    async (args, extra) => exitWorktreeHandler(args, makeCtx(args, extra)),
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );

  // plan task-mcp-merge-into-agent-deck-mcp-20260521：5 个 task tool 合并入 agent-deck-mcp
  // namespace（工具名从 mcp__tasks__task_* 切到 mcp__agent-deck__task_*，breaking change）。
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
      // 与现状 contract 对齐（not-found 返 isError 不是 noop；不像 shutdown_session 已 closed noop 等价）。
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
    `Log a problem you hit but should NOT fix right now — work the current task surfaced that's out of scope (kind="follow-up", the default), or a bug in Agent Deck itself (kind="app-bug"). Use this instead of silently dropping it or cramming an unrelated fix into the current change. If you can just fix it now, fix it — don't report. Only title + description are required; write description self-contained so a triager gets it without reading logs. Returns the created issue; if you need to add more to it later this same session, pass the returned \`id\` to append_issue_context / update_issue_status.`,
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
    `Add more context to an issue YOU reported earlier in THIS session (pass its \`id\` as \`issueId\`). New content is appended as a separate note — it never rewrites the original description. Rejected if the issue is from another session or deleted (report a new issue instead — a deleted one can only be restored from the UI), or resolved (reopen it first with update_issue_status).`,
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
    `Change an issue's status yourself — resolve one you fixed (status="resolved"), or reopen one (status="open" / "in-progress") — without waiting for a human to click in the UI. Only the issue's source session (who reported it) or resolution session (the one UI「起新会话解决」spawned to fix it) may call this; anyone else is rejected, as are soft-deleted issues (restore from the UI first). Optionally pass \`note\` to record how you fixed it / why you reopened it.`,
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
    handOffSession,
    enterWorktree,
    exitWorktree,
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
