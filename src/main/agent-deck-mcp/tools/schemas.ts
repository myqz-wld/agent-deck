/**
 * Agent Deck MCP server zod schema 集中地。公开 registry 暴露 18 个 tool:
 * 6 session/messaging + 2 user presentation + 2 worktree + 5 task + 3 issue。archive_plan / shutdown_baton_teammates
 * 只保留为退役 guard/type 兼容键,不注册给 SDK agent。
 * 三 transport（in-process / HTTP / stdio）共享同一份 schema。
 *
 * 历史：从原 src/main/agent-deck-mcp/tools.ts 剥离（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：协议大简化删除旧 reply
 * 轮询三件套 schema。所有发送统一走 send_message + replyToMessageId；
 * reply 直接进 lead conversation flow（无需主动 poll）。
 *
 * 字段命名约定：tool args **camelCase**（plan mcp-tool-camelcase-migration-20260529
 * 改造，从 snake_case → camelCase 入参出参对齐）；handler 内部直接消费 args.<camelCase>
 * 不再手工映射。
 *
 * 公开 tool description 的读者是 SDK agent。每个描述先写何时调用和关键参数;
 * 项目组织规则由当前项目或 skill 承担,不要写进通用 MCP schema。
 */

import { z } from 'zod';
import type { IssueRecord, TaskRecord } from '@shared/types';

const SDK_CALLER_SESSION_ID_DESCRIPTION =
  'Leave unset in SDK sessions; Agent Deck injects the real caller session id and ignores forged in-prompt values. Direct HTTP/stdio callers without a real Agent Deck session are treated as external.';
const SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION =
  `${SDK_CALLER_SESSION_ID_DESCRIPTION} This tool rejects external callers.`;
const SDK_READ_CALLER_SESSION_ID_DESCRIPTION =
  `${SDK_CALLER_SESSION_ID_DESCRIPTION} Read-only external callers may call read tools; each tool defines its own visibility and authorization semantics.`;

/**
 * Task tool status 枚举（plan task-mcp-merge-into-agent-deck-mcp-20260521 Step 0.5 + R2 F-R2-4 修法）：
 * 放 schemas.ts 顶部 export 而非 handler/task-helpers.ts —— schema 层 enum 天然位置，
 * 避免 schema 层从 handler 层间接拉 sessionRepo / agentDeckTeamRepo 运行时依赖，
 * 破坏 schemas.ts 只依赖 zod 的纯 schema 边界。5 个 task tool schema + 5 handler 都从本处 import。
 *
 * 对齐 Claude Code CLI TaskCreate / TaskUpdate 状态字段语义。
 */
export const STATUS_VALUES = [
  'pending',
  'active',
  'completed',
  'blocked',
  'abandoned',
] as const;
export type TaskStatusValue = (typeof STATUS_VALUES)[number];

export const SPAWN_SESSION_MODEL_VALUES = [
  'haiku',
  'sonnet',
  'opus',
  'fable',
  'gpt-5.5',
  'gpt-5.4',
  'v4-flash',
  'v4-pro',
] as const;
export type SpawnSessionModelValue = (typeof SPAWN_SESSION_MODEL_VALUES)[number];

export const SPAWN_SESSION_THINKING_VALUES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type SpawnSessionThinkingValue = (typeof SPAWN_SESSION_THINKING_VALUES)[number];

export const SPAWN_SESSION_SCHEMA = {
  adapter: z
    .enum(['claude-code', 'deepseek-claude-code', 'codex-cli'])
    .describe(
      'Choose the SDK adapter that runs the new session: "claude-code", "deepseek-claude-code", or "codex-cli". The target adapter can differ from the caller adapter.',
    ),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
      'Must be absolute path',
    )
    .describe(
      'Working directory for the new session. Must be an absolute path (e.g. /Users/.../repo or a worktree dir); relative paths are rejected.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      'First user message sent to the new session (the task / instructions). When `agentName` is omitted, the session is generic and receives this prompt plus the normal runtime baseline. When `agentName` is set, Agent Deck starts the target adapter with that agent through adapter-native fields and still sends this prompt as the task. For long context, write a file under /tmp and tell the spawned session to read it; this is a general prompt convention, not a special handoff feature.',
    ),
  teamName: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Optional team to form or reuse. Omit for a standalone session; standalone sessions can still exchange teamless DMs through send_message but do not appear together in TeamDetail. Set to make the caller a lead and the new session a teammate in that active team.',
    ),
  /**
   * Optional adapter-native agent selection. Claude-family targets use SDK `agent` + `agents`;
   * Codex targets parse official TOML custom-agent files and map supported config fields to
   * app-server thread/developerInstructions/config options. Unknown names reject.
   */
  agentName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/, 'agentName only allows [a-zA-Z0-9._-]')
    .optional()
    .describe(
      'Optional real agent name. Resolution is adapter-scoped: bundled Agent Deck reviewers first, then project agents (.claude/agents/<name>.md or .codex/agents/*.toml under cwd), then user agents (~/.claude/agents/<name>.md or ~/.codex/agents/*.toml). Claude starts with SDK agent/agents; Codex uses TOML developer_instructions plus supported config fields. For a normal/general-purpose spawned session, omit agentName and put complete instructions in prompt; use displayName only for labels. Unknown names reject.',
    ),
  model: z
    .enum(SPAWN_SESSION_MODEL_VALUES)
    .optional()
    .describe(
      'Optional model override for this spawned session. Valid combinations are adapter-scoped: claude-code accepts haiku, sonnet, opus, fable; codex-cli accepts gpt-5.5, gpt-5.4; deepseek-claude-code accepts v4-flash, v4-pro. Explicit model overrides any bundled agent frontmatter model.',
    ),
  thinking: z
    .enum(SPAWN_SESSION_THINKING_VALUES)
    .optional()
    .describe(
      'Optional thinking / reasoning complexity for this spawned session. Valid combinations are adapter-scoped: codex-cli accepts minimal, low, medium, high, xhigh; claude-code and deepseek-claude-code accept low, medium, high, xhigh, max. Explicit thinking overrides any agent-defined effort (Claude agent frontmatter `effort` / Codex agent `model_reasoning_effort`).',
    ),
  /**
   * REVIEW_31 Bug 4：teammate 显示名（覆盖 session.title 默认 cwd-basename）。
   * UI 列表 / SessionCard / TeamDetail / wire format wireBody 全走 displayName 优先级链
   * （argument > agentName > 默认 cwd-basename）—— 解决"多 reviewer 都显示同一个 cwd 区分不出"的体验问题。
   */
  displayName: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Optional human-readable display name for the spawned session (e.g. "reviewer-claude · batch A", "patch-coder", "prompt-editor"). Use this for naming a generic teammate; do not set `agentName` just to label the session. When omitted, falls back to agentName (if set), otherwise cwd-basename. Becomes session.title (visible in SessionList / TeamDetail) and team_member.displayName (visible in wire format prefix).',
    ),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .optional()
    .describe(
      'Explicit permission-mode override for a spawned Claude-family session. Omit unless the user explicitly requests this permission mode; omitted values let Agent Deck inherit from a same-adapter caller or use the target adapter default. codex-cli ignores this field.',
    ),
  codexSandbox: z
    .enum(['workspace-write', 'read-only', 'danger-full-access'])
    .optional()
    .describe(
      'Explicit sandbox override for a codex-cli spawned session, including bundled reviewer agents. Omit unless the user explicitly requests this sandbox mode; omitted values let Agent Deck inherit from a same-adapter codex caller or use the codex adapter default.',
    ),
  claudeCodeSandbox: z
    .enum(['off', 'workspace-write', 'strict'])
    .optional()
    .describe(
      'Explicit OS sandbox override for a claude-code or deepseek-claude-code spawned session. Omit unless the user explicitly requests this sandbox mode; omitted values let Agent Deck inherit from a same-adapter caller or use the target adapter default.',
    ),
  /**
   * 可选额外 writable roots（仅 claude-code adapter + workspace-write 档生效）。
   * 目标 Claude session 需要写 cwd 外路径时传；same-adapter spawn 会继承 caller 既有值。
   */
  extraAllowWrite: z
    .array(z.string().min(1).max(4096))
    .max(16)
    .optional()
    .describe(
      'Extra writable roots for a claude-code workspace-write sandbox. Use only when the spawned Claude-family session must edit paths outside cwd.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
  parentSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Internal spawn-link plumbing; direct callers leave unset so the handler uses the caller as parent.'),
  // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 internal plumbing:
  // hand_off_session handler 装配后透传给本 spawn handler,后者透传给 buildCreateSessionOptions
  // → adapter narrow → bridge createSession → finalize / thread-loop / resume emit first user
  // message 时 spread 进 events.payload。详 HandOffMetadata jsdoc + plan §不变量 5。
  handOff: z
    .object({
      mode: z.literal('session'),
      fromCallerSid: z.string(),
    })
    .optional()
    .describe(
      'hand_off_session internal plumbing; direct callers leave unset. When set, the adapter emits this metadata on the first user message events.payload so renderer can render a session hand-off badge.',
    ),
};

export const SEND_MESSAGE_SCHEMA = {
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .describe('Target session id to receive the message. When replying, use the `<senderSid>` from the `[msg <id>][sid <senderSid>]` wire prefix of the received message. Dormant targets resume automatically; closed targets reject, and the caller cannot send to itself.'),
  text: z
    .string()
    .min(1)
    .max(100_000)
    .describe('Message body to inject as a user-role turn in the target session. Include enough context for the receiver to act without polling.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
  // R3.E0 ADR §5.2 amend：multi-team 共享时必填，单 team 共享时可省（自动 resolve）。
  // plan teamless-dm-20260601：无 shared team 时省略 teamId → teamless DM（自动降级）。
  teamId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Team scope for this message. Required when caller and target share more than one active team; optional when sharing exactly one (auto-resolved). When they share NO active team, omit it to send a teamless DM (delivered to the target session but not shown in any team panel). If you pass a teamId that is not a shared active team, the call is rejected (not silently downgraded).',
    ),
  // plan team-cohesion-fix-20260513 Phase B Step B2：可选对话链关联
  replyToMessageId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Message id being answered: the `<id>` from the `[msg <id>][sid <senderSid>]` wire prefix of the received message, or `spawnPromptMessageId` for the first reply after spawn. Links this message into that reply chain; the receiver sees it auto-injected as a user-role message — no polling. Omit when starting a new topic. The original message team must match the resolved teamId; cross-team chains are rejected.',
  ),
};

export const REQUEST_PLAN_REVIEW_SCHEMA = {
  plan: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      'Markdown plan to present to the user. Call this when you need the user to see a plan and either confirm it or send revision feedback before you continue.',
    ),
  title: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Optional short title shown above the plan presentation card.'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .optional()
    .describe(
      'Optional timeout in milliseconds. Omit to use the app permission-request timeout; when that setting is 0, omitted timeoutMs waits until the user confirms or asks for revisions.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

const DIFF_REVIEW_TEXT = z.string().max(100_000);

export const DIFF_REVIEW_PR_FRAGMENT_SCHEMA = z
  .object({
    before: DIFF_REVIEW_TEXT.describe('Original content for the left side of the two-column presentation.'),
    after: DIFF_REVIEW_TEXT.describe('Proposed content for the right side of the two-column presentation.'),
    beforeLabel: z.string().min(1).max(80).optional().describe('Optional label for the original side. Defaults should be UI-owned, not agent-owned.'),
    afterLabel: z.string().min(1).max(80).optional().describe('Optional label for the proposed side. Defaults should be UI-owned, not agent-owned.'),
    unifiedDiff: DIFF_REVIEW_TEXT.optional().describe('Optional unified diff shown as supporting context or fallback when before/after rendering is insufficient; do not pass it instead of before and after.'),
  })
  .strict();

export const DIFF_REVIEW_CONFLICT_FRAGMENT_SCHEMA = z
  .object({
    ours: DIFF_REVIEW_TEXT.describe('Current/ours content for the conflict.'),
    theirs: DIFF_REVIEW_TEXT.describe('Incoming/theirs content for the conflict.'),
    resolution: DIFF_REVIEW_TEXT.describe('Proposed final resolved content for the user to confirm or revise.'),
    base: DIFF_REVIEW_TEXT.optional().describe('Optional common ancestor content, shown only when useful for understanding the resolution.'),
    oursLabel: z.string().min(1).max(80).optional().describe('Optional display label for the current/ours pane. Defaults should be UI-owned, not agent-owned.'),
    theirsLabel: z.string().min(1).max(80).optional().describe('Optional display label for the incoming/theirs pane. Defaults should be UI-owned, not agent-owned.'),
    resolutionLabel: z.string().min(1).max(80).optional().describe('Optional display label for the resolution pane. Defaults should be UI-owned, not agent-owned.'),
    baseLabel: z.string().min(1).max(80).optional().describe('Optional display label for the common-base pane. Defaults should be UI-owned, not agent-owned.'),
  })
  .strict();

export const REQUEST_DIFF_REVIEW_SCHEMA = {
  mode: z
    .enum(['pr', 'merge-conflict'])
    .describe('Presentation layout and payload selector. Use "pr" for a two-column before/after presentation and provide `pr`; use "merge-conflict" for an ours/theirs/resolution presentation and provide `conflict`.'),
  title: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Optional short title shown above the diff presentation card.'),
  filePath: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe('Optional repository-relative or display path for the file being presented. Use it for labels only; the tool does not read the file from disk.'),
  language: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe('Optional language id used for syntax highlighting, such as typescript, tsx, markdown, or json.'),
  instructions: z
    .string()
    .min(1)
    .max(10_000)
    .optional()
    .describe('Optional focused presentation instructions or acceptance criteria shown with the diff, such as risk areas, intended behavior, or specific questions for the user. In a step-by-step walkthrough, use it to scope what the user should confirm for the current fragment.'),
  rationale: z
    .string()
    .min(1)
    .max(40_000)
    .describe('Short explanation shown above the diff so the user understands what they are confirming and why the change is being presented.'),
  pr: DIFF_REVIEW_PR_FRAGMENT_SCHEMA.optional().describe('Two-column PR-style diff payload. Required when mode="pr"; omit when mode="merge-conflict".'),
  conflict: DIFF_REVIEW_CONFLICT_FRAGMENT_SCHEMA.optional().describe('Merge-conflict presentation payload. Required when mode="merge-conflict"; omit when mode="pr".'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .optional()
    .describe(
      'Optional timeout in milliseconds. Omit to use the app permission-request timeout; when that setting is 0, omitted timeoutMs waits until the user confirms or requests changes.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const LIST_SESSIONS_SCHEMA = {
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_READ_CALLER_SESSION_ID_DESCRIPTION),
  statusFilter: z
    .enum(['active', 'dormant', 'closed', 'all'])
    .default('active')
    .describe('Filter sessions by lifecycle. Defaults to active and, for real session callers, only returns caller-related sessions. Use "all" when recovering old teammates or checking whether a session was closed.'),
  adapterFilter: z
    .enum(['claude-code', 'deepseek-claude-code', 'codex-cli'])
    .optional()
    .describe('Optional adapter filter. Omit it to include all adapters. When set, it is applied in the session query before output pagination.'),
  spawnedByFilter: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Filter to sessions whose spawnedBy equals this id. Use it to recover children after a lead context reset: pass the old lead session id to find stranded teammates, then message them by session id. No ownership check; any caller may query any spawnedBy id.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum sessions to return. Default 50, max 200.'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(0)
    .describe('Number of matching sessions to skip before returning results. Default 0.'),
};

export const GET_SESSION_SCHEMA = {
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_READ_CALLER_SESSION_ID_DESCRIPTION),
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .describe('Session id to inspect. Use list_sessions to discover ids before calling when unsure.'),
};

export const SHUTDOWN_SESSION_SCHEMA = {
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .describe('Target session id to close. The caller cannot shut down itself.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('Optional short reason recorded for operators; it does not change shutdown behavior.'),
};

// Retired public tool schema. Keep this only so legacy internal handlers/tests and guard
// keys type-check while buildAgentDeckTools no longer exposes archive_plan to SDK agents.
export const ARCHIVE_PLAN_SHAPE = {
  planId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'planId only allows [A-Za-z0-9._-]')
    .describe(
      'Retired archive_plan compatibility field. Public SDK agents do not receive this tool.',
    ),
  worktreePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .describe(
      'Retired archive_plan compatibility field. Public SDK agents do not receive this tool.',
    ),
  baseBranch: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Retired archive_plan compatibility field. Public SDK agents do not receive this tool.',
    ),
  planFilePath: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Retired archive_plan compatibility field. Public SDK agents do not receive this tool.',
    ),
  changelogId: z
    .string()
    .regex(
      /^\s*\d+(\s*,\s*\d+)*\s*$/,
      'changelogId must be a digit (e.g. "122") or comma-separated digits (e.g. "121,122" / "121, 122") matching CHANGELOG_X.md naming; whitespace around digits/commas allowed',
    )
    .optional()
    .describe(
      'Retired archive_plan compatibility field. Public SDK agents do not receive this tool.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Retired archive_plan compatibility field. Public SDK agents do not receive this tool.',
    ),
};

// =============== HAND_OFF_SESSION (session baton) ===============

// hand_off_session starts a successor SDK session, transfers the caller's session-owned
// resources to it, and closes the caller only after mandatory transfer succeeds. It is not a
// plan tool: plan paths, temporary files, and next-step requirements belong in `prompt`, the
// same way they do for spawn_session.
export const HAND_OFF_SESSION_SHAPE = {
  prompt: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      'Cold-start prompt for the successor session. Include any plan file path, temporary context file path, current progress, and the next action directly in this text. For long context, write a file under /tmp and tell the new session to read it; this is the same prompt convention used by spawn_session.',
    ),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
      'Must be absolute path',
    )
    .optional()
    .describe(
      'Override cwd for the successor session. Omit it to inherit the caller session cwd. Pass an existing absolute directory when the successor should start somewhere else.',
    ),
  adapter: z
    .enum(['claude-code', 'deepseek-claude-code', 'codex-cli'])
    .default('claude-code')
    .describe(
      'Adapter for the successor session. Defaults to "claude-code". Set "deepseek-claude-code" or "codex-cli" when the successor must run through that adapter.',
    ),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .optional()
    .describe(
      'Permission mode for the new SDK session. When omitted, follows spawn_session defaults: same target adapter as caller inherits caller permissionMode; cross-adapter spawn uses target adapter defaults (claude-code / deepseek-claude-code default bypassPermissions; codex-cli has no permissionMode).',
    ),
  codexSandbox: z
    .enum(['workspace-write', 'read-only', 'danger-full-access'])
    .optional()
    .describe(
      'codex-cli sandbox override for the new SDK session. When omitted, follows spawn_session defaults: same-adapter codex handoff inherits caller codexSandbox; cross-adapter handoff lets codex adapter use settings default. Pass explicitly to override (e.g. baton from claude lead to codex-cli with stricter "read-only" for sensitive task). Mirrors spawn_session.codexSandbox 1:1.',
    ),
  claudeCodeSandbox: z
    .enum(['off', 'workspace-write', 'strict'])
    .optional()
    .describe(
      'claude-code / deepseek-claude-code OS sandbox override for the new SDK session. When omitted, follows spawn_session defaults: same target adapter as caller inherits caller claudeCodeSandbox; cross-adapter handoff lets target adapter use settings global. Pass explicitly to override (e.g. baton to a phase that needs "strict" while caller was "workspace-write"). Mirrors spawn_session.claudeCodeSandbox 1:1.',
    ),
  /**
   * REVIEW_36 R2 HIGH-B + MED-C：可选额外 writable roots（仅 claude-code adapter + workspace-write 档生效）。
   */
  extraAllowWrite: z
    .array(z.string().min(1).max(4096))
    .max(16)
    .optional()
    .describe(
      'Extra writable roots for the successor session sandbox (claude-code adapter + workspace-write only). Use it when the prompt asks the successor to edit paths outside cwd.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
  parentSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Internal plumbing for spawn lineage during handoff; direct callers leave unset.'),
};

// enter_worktree / exit_worktree provide a plan-free git worktree lifecycle. The caller chooses
// a base branch, the tool resolves that branch's current commit, creates a work branch from it,
// and records the worktree marker for the caller session.
export const ENTER_WORKTREE_SCHEMA = {
  baseBranch: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Pass a named local branch to use as the worktree base. The tool resolves refs/heads/<baseBranch> to a commit and creates the work branch from that exact branch version. SHA, tag, remote-only refs, and rev syntax are rejected.',
    ),
  workBranch: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._\\/-]+$/, 'workBranch only allows [A-Za-z0-9._/-]')
    .optional()
    .describe(
      'Optional new branch name for the worktree. Omit it to let Agent Deck derive a unique branch name from the caller session and baseBranch. The branch must not already exist.',
    ),
  worktreePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute worktree path. Pass it only when an external workflow owns the worktree layout; the path must not already exist.',
    ),
  worktreeRoot: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute root used to derive worktreePath when worktreePath is omitted. Omit both worktreePath and worktreeRoot to use Agent Deck runtime worktree storage under the main repo.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const EXIT_WORKTREE_SCHEMA = {
  worktreePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute worktree path to clean up. Omit it to use the caller session worktree marker set by enter_worktree. Passing a different path while the caller holds a marker is rejected.',
    ),
  discardChanges: z
    .boolean()
    .optional()
    .describe(
      'Default false. The tool refuses to remove a dirty worktree unless this is true. Do not pass true unless the user explicitly wants to abandon uncommitted changes.',
    ),
  deleteBranch: z
    .boolean()
    .optional()
    .describe(
      'Default false. exit_worktree removes the worktree directory and keeps the work branch so committed work is not lost. Set true only after the work has been merged, cherry-picked, or intentionally abandoned; unmerged branch deletion is rejected unless discardChanges=true.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

// Retired public tool schema. Keep this only so legacy internal handlers/tests and guard
// keys type-check while buildAgentDeckTools no longer exposes shutdown_baton_teammates to SDK agents.
export const SHUTDOWN_BATON_TEAMMATES_SCHEMA = {
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Retired shutdown_baton_teammates compatibility field. Public SDK agents do not receive this tool.',
    ),
  planId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'planId only allows [A-Za-z0-9._-]')
    .optional()
    .describe(
      'Retired shutdown_baton_teammates compatibility field. Public SDK agents do not receive this tool.',
    ),
};

export type SpawnSessionArgs = z.infer<z.ZodObject<typeof SPAWN_SESSION_SCHEMA>>;
export type SendMessageArgs = z.infer<z.ZodObject<typeof SEND_MESSAGE_SCHEMA>>;
export type RequestPlanReviewArgs = z.infer<z.ZodObject<typeof REQUEST_PLAN_REVIEW_SCHEMA>>;
export type RequestDiffReviewArgs = z.infer<z.ZodObject<typeof REQUEST_DIFF_REVIEW_SCHEMA>>;
export type ListSessionsArgs = z.infer<z.ZodObject<typeof LIST_SESSIONS_SCHEMA>>;
export type GetSessionArgs = z.infer<z.ZodObject<typeof GET_SESSION_SCHEMA>>;
export type ShutdownSessionArgs = z.infer<z.ZodObject<typeof SHUTDOWN_SESSION_SCHEMA>>;

export const ARCHIVE_PLAN_ARGS_SCHEMA = z.object(ARCHIVE_PLAN_SHAPE).strict();
export const HAND_OFF_SESSION_ARGS_SCHEMA = z.object(HAND_OFF_SESSION_SHAPE).strict();

export type ArchivePlanArgs = z.infer<typeof ARCHIVE_PLAN_ARGS_SCHEMA>;
export type HandOffSessionArgs = z.infer<typeof HAND_OFF_SESSION_ARGS_SCHEMA>;
export type EnterWorktreeArgs = z.infer<z.ZodObject<typeof ENTER_WORKTREE_SCHEMA>>;
export type ExitWorktreeArgs = z.infer<z.ZodObject<typeof EXIT_WORKTREE_SCHEMA>>;
export type ShutdownBatonTeammatesArgs = z.infer<
  z.ZodObject<typeof SHUTDOWN_BATON_TEAMMATES_SCHEMA>
>;

// =============== Result types (R37 P3-L Step 4.5) ===============
//
// 18 public tool ok return shape SSOT, plus retired compatibility result types for legacy
// handlers that are no longer registered. Handler return 用 `satisfies XxxResult` 做静态字段校验
// 防漂移（typo / 漏字段 / 字段类型错被 TS 拦）。
//
// **设计权衡**：
// - **不抽 typed builder**（保留 helpers.ts 的 untyped `ok(data: unknown)` 8 处统一调用）
//   typed builder 增加 indirection（每个 tool 多一层 wrapper），satisfies 校验已能完成
//   核心收益「字段拼写错被 TS 拦」，wrapper 收益是 marginal 类型文档
// - **HandOffSessionResult extends SpawnSessionResult**：hand-off-session 用 `...spawnData`
//   spread 透传 spawn return 字段；用 extends 让 spread 后字段被 satisfies 静态校验
// - retired result types stay local to this file so old handlers compile without adding
//   retired tools back into the public registry.

/** sessions.list_sessions / get_session 共享的 metadata 投影（与 helpers.ts projectSession 对齐 — 字段漂移此处 satisfies 必拦）。 */
export interface ProjectedSession {
  sessionId: string;
  adapter: string;
  cwd: string;
  lifecycle: 'active' | 'dormant' | 'closed';
  title: string | null;
  lastEventAt: number | null;
  teamName: string | null;
  teams: Array<{ teamId: string; teamName: string }>;
  spawnedBy: string | null;
  spawnDepth: number;
}

/**
 * Retired baton cleanup result detail retained for legacy archive handlers.
 */
type TeammatesShutdownInfo = {
  closed: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  // REVIEW_56 Batch B R2 reviewer-claude M2 修法: skipped 加 'all-lead-teams-archived' 第四态
  // 区分 caller 不是 lead vs caller 是 lead 但所有相关 team 已 archived (UX 精度)。
  // REVIEW_56 §F6 修法 (Plan-Review Round 2 codex MED-3): 加 'phase-1-error' 第五态,
  // 区分 caller layer `runBatonCleanup` 内 helper 自身抛错的兜底(罕见 DB 异常 / mock 失败) vs
  // 正常处理 null(caller=lead 但无其他 active teammate)。
  skipped:
    | 'caller-not-lead'
    | 'all-lead-teams-archived'
    | 'adopt-keep-implicit'
    | 'phase-1-error'
    | 'archive-caller-false-keep'
    | null;
};

/** list_sessions ok return shape（list.ts handler）。 */
export interface ListSessionsResult {
  total: number;
  /** True when another page may be available with offset + limit. */
  hasMore: boolean;
  sessions: ProjectedSession[];
}

/** get_session ok return shape（get.ts handler）。 */
export type GetSessionResult = ProjectedSession;

/** send_message ok return shape（send.ts handler；queued: true 字面常量约束）。 */
export interface SendMessageResult {
  sessionId: string;
  teamId: string | null;
  messageId: string;
  replyToMessageId: string | null;
  sentAt: number;
  queued: true;
}

export type RequestPlanReviewResult =
  | { decision: 'approved' }
  | { decision: 'revise'; feedback?: string }
  | { decision: 'timeout' };

export type RequestDiffReviewResult =
  | { decision: 'approved' }
  | { decision: 'revise'; feedback?: string }
  | { decision: 'timeout' };

/** shutdown_session ok return shape（shutdown.ts handler；lifecycle: 'closed' 字面常量约束）。 */
export interface ShutdownSessionResult {
  sessionId: string;
  lifecycle: 'closed';
  alreadyClosed: boolean;
}

/** spawn_session guard limits exposed to callers on success and guard-deny paths. */
export interface SpawnSessionLimits {
  depth: {
    /** Caller session depth before this spawn. */
    current: number;
    /** Spawned session depth on success, or the normal-spawn attempted next depth on guard deny. */
    next: number;
    max: number;
  };
  fanOut: {
    /** Active children plus in-flight spawn reservations for this caller. */
    current: number;
    activeChildren: number;
    inFlight: number;
    max: number;
  };
  rate: {
    /** Used spawn tokens in the current sliding window. */
    current: number;
    max: number;
    windowMs: number;
    retryAfterMs: number;
  };
}

/** spawn_session ok return shape（spawn.ts handler；hand-off-session 通过 extends 复用全部字段）。 */
export interface SpawnSessionResult {
  sessionId: string;
  adapter: string;
  cwd: string;
  teamId: string | null;
  teamName: string | null;
  agentName: string | null;
  /** displayName 优先 → agentName → null（spawn.ts:163 三级 fallback）。 */
  displayName: string | null;
  spawnDepth: number;
  spawnLimits: SpawnSessionLimits;
  sentAt: number;
  spawnPromptMessageId: string | null;
}

/** Retired archive_plan ok return shape kept for legacy handlers. */
export interface ArchivePlanResult {
  archivedPath: string;
  commitHash: string;
  branchDeleted: string;
  worktreeRemoved: string;
  plansIndexAction: 'created' | 'appended' | 'updated' | 'unchanged';
  finalStatus: 'completed';
  warnings: string[];
  spikeReportsArchived: { srcPath: string; dstPath: string } | null;
  archived: 'ok' | 'failed' | 'skipped';
  teammatesShutdown: TeammatesShutdownInfo;
}

/**
 * hand_off_session ok return shape（hand-off-session.ts handler）。
 *
 * **extends SpawnSessionResult**：hand-off 内部调 spawnSessionHandler 拿到 spawn return
 * 字段后 spread 透传（caller 拿到 K2 metadata + spawn 字段都齐）。extends 让 satisfies
 * 校验时 TS 知道 spread 字段已 cover SpawnSessionResult 全部字段。
 */
export interface HandOffSessionResult extends SpawnSessionResult {
  /** cold-start prompt 完整字面（caller 可对照 sessionRepo.events 验证 spawn first message 一致）。 */
  initialPrompt: string;
  /** caller close result after resource transfer. */
  callerClosed: 'ok' | 'failed';
  /** Resource transfer is mandatory; success returns details here, failure returns MCP error. */
  resourceTransfer: {
    tasks: { status: 'ok' | 'failed'; count: number; error?: string };
    teams: {
      status: 'ok' | 'failed';
      transferred: Array<{ teamId: string; role: 'lead' | 'teammate' }>;
      skipped: Array<{ teamId: string; role: 'lead' | 'teammate'; reason: string }>;
      failed: Array<{ teamId: string; role: 'lead' | 'teammate'; reason: string }>;
    };
    worktreeMarker: { status: 'ok' | 'skipped' | 'failed'; marker: string | null; error?: string };
  };
}

/** enter_worktree ok return shape. */
export interface EnterWorktreeResult {
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  baseCommit: string;
  baseSource: 'base-branch';
  markerSet: boolean;
}

/** exit_worktree ok return shape. */
export interface ExitWorktreeResult {
  worktreePath: string;
  workBranch: string | null;
  branchDeleted: boolean;
  worktreeRemoved: boolean;
  markerCleared: boolean;
}

/** Retired shutdown_baton_teammates ok return shape kept for legacy handlers. */
export interface ShutdownBatonTeammatesResult {
  closed: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  skipped: null;
  planId: string | null;
}

// =============== TASK_* (plan task-mcp-merge-into-agent-deck-mcp-20260521 合并 5 个 task tool) ===============
//
// 5 个 task tool schema：从原 src/main/task-manager/tools.ts 抽出，转 agent-deck-mcp 同款 SHAPE 模式。
//
// **D5 修法**：schema 加 callerSessionId?（与现有 10 个 simple tool 同款 — in-process closure
// override 优先于 args 字段）。task_create owner_session_id 不在 schema 暴露（closure 强制注入
// ctx.caller.callerSessionId）。
//
// 协议: callerSessionId 字段在 in-process / HTTP / stdio 三 transport 行为见 SPAWN_SESSION_SCHEMA
// 同字段注释。task 5 个 tool 同款语义。

export const TASK_CREATE_SCHEMA = {
  subject: z
    .string()
    .min(1)
    .max(200)
    .describe('Short task title shown in task lists (1-200 chars).'),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('Optional detailed description (max 2000 chars). Pass null or omit when not provided.'),
  status: z
    .enum(STATUS_VALUES)
    .optional()
    .describe(
      'Initial status. Use pending, active, completed, blocked, or abandoned. Default is pending. Use active for in-progress work and completed for finished work.',
    ),
  activeForm: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Optional present-tense activity label shown in the Tasks UI, such as "Running tests".',
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Optional priority from 0 to 10. Default is 5.'),
  blocks: z
    .array(z.string())
    .optional()
    .describe('Optional task UUIDs of downstream tasks that this task blocks.'),
  blockedBy: z
    .array(z.string())
    .optional()
    .describe('Optional task UUIDs of upstream tasks that block this task.'),
  labels: z.array(z.string()).optional().describe('Optional free-form tags for filtering or grouping.'),
  // v024 plan task-team-id-restore-20260525 §D1+D2:teamId 字段
  teamId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Omit for a personal task visible only to the owner. Pass a team id for a team task visible and writable by active team members; the caller must be an active member.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_LIST_SCHEMA = {
  statusFilter: z
    .enum(STATUS_VALUES)
    .optional()
    .describe(
      'Only return tasks with this status: pending, active, completed, blocked, or abandoned.',
    ),
  subjectFilter: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring match on task subject.'),
  // v024 plan task-team-id-restore-20260525 §D5:teamIdFilter 三态 — FROZEN by Round 1 LOW-1
  // 用 zod literal `z.union([z.string().uuid(), z.literal('null-personal')])` 让 caller 显式表达。
  // 实际改用 z.union([z.string().min(1).max(128), z.literal('null-personal')]) 不强制 UUID 格式
  // (teamId 现实是 uuid 但 schema 层不绑死格式,与 task_create.teamId 字段一致).
  teamIdFilter: z
    .union([z.string().min(1).max(128), z.literal('null-personal')])
    .optional()
    .describe(
      "Optional task scope filter. Omit for all tasks visible to caller (caller-owned personal tasks plus team tasks from active memberships); pass a team id for that team's tasks (caller must be an active member); pass 'null-personal' for caller-owned personal tasks only.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum tasks to return. Default 100, max 500.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of matching tasks to skip before returning results. Default 0.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_READ_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_GET_SCHEMA = {
  taskId: z.string().describe('Task UUID returned by task_create.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_UPDATE_SCHEMA = {
  taskId: z.string().describe('Task UUID to update.'),
  subject: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional replacement task title (1-200 chars). Omit to leave unchanged.'),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('Optional replacement description. Omit to leave unchanged; pass null to clear.'),
  status: z
    .enum(STATUS_VALUES)
    .optional()
    .describe(
      'New status: pending, active, completed, blocked, or abandoned. Use active for in-progress work and completed for finished work.',
    ),
  activeForm: z
    .string()
    .nullable()
    .optional()
    .describe('Optional present-tense activity label. Omit to leave unchanged; pass null to clear.'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Optional replacement priority from 0 to 10. Omit to leave unchanged.'),
  blocks: z
    .array(z.string())
    .optional()
    .describe('Task UUIDs that replace the whole blocks list. Omit to leave unchanged; pass [] to clear.'),
  blockedBy: z
    .array(z.string())
    .optional()
    .describe('Task UUIDs that replace the whole blockedBy list. Omit to leave unchanged; pass [] to clear.'),
  labels: z
    .array(z.string())
    .optional()
    .describe('Labels that replace the whole labels list. Omit to leave unchanged; pass [] to clear.'),
  // v024 plan task-team-id-restore-20260525 §D1:允许 update 改 teamId(传 null 转 personal;
  // 传 string 转 team-bound)。caller 必须在新 teamId 是 active member(D3 由 tool 层校验)。
  teamId: z
    .string()
    .min(1)
    .max(128)
    .nullable()
    .optional()
    .describe(
      'Omit to leave unchanged. Pass a team id to make the task team-bound; the caller must be an active member. Pass null to make it personal to the caller.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const TASK_DELETE_SCHEMA = {
  taskId: z.string().describe('Task UUID to delete. Missing tasks return an MCP error.'),
  force: z
    .boolean()
    .optional()
    .describe('Default false. Pass true to recursively delete writable downstream tasks listed in blocks; non-writable downstream tasks are skipped.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

// Args type infer（与现有 10 个 simple tool 同款 z.infer<z.ZodObject<typeof SCHEMA>>）
export type TaskCreateArgs = z.infer<z.ZodObject<typeof TASK_CREATE_SCHEMA>>;
export type TaskListArgs = z.infer<z.ZodObject<typeof TASK_LIST_SCHEMA>>;
export type TaskGetArgs = z.infer<z.ZodObject<typeof TASK_GET_SCHEMA>>;
export type TaskUpdateArgs = z.infer<z.ZodObject<typeof TASK_UPDATE_SCHEMA>>;
export type TaskDeleteArgs = z.infer<z.ZodObject<typeof TASK_DELETE_SCHEMA>>;

// Result types — handler return 用 `satisfies XxxResult` 校验

/** task_create ok return shape (handlers/task-create.ts)。 */
export type TaskCreateResult = TaskRecord;

/**
 * task_list ok return shape (handlers/task-list.ts)。
 *
 * F4 修法 (deep-review Round 1 reviewer-claude MED-c2)：total 仅是当前页 task 数
 * (post-LIMIT/OFFSET 已截断的数组长度)；hasMore = tasks.length === effectiveLimit
 * 提示 caller 是否需要翻下一页。完整 matching count 不暴露（不另起 SELECT COUNT(*)）。
 */
export interface TaskListResult {
  total: number;
  hasMore: boolean;
  tasks: TaskRecord[];
}

/** task_get ok return shape (handlers/task-get.ts)。 */
export type TaskGetResult = TaskRecord;

/** task_update ok return shape (handlers/task-update.ts)。 */
export type TaskUpdateResult = TaskRecord;

/**
 * task_delete ok return shape (handlers/task-delete.ts)。
 * - success: deletedIds.length > 0 即视为成功（cascade=false 至少删 target；cascade=true 含下游）
 * - taskId: 透传 args.taskId（root 删除目标）
 * - deletedIds: 实际被删的所有 task id（root + cascade 下游）
 */
export interface TaskDeleteResult {
  success: boolean;
  taskId: string;
  deletedIds: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Issue Tracker (plan issue-tracker-mcp-20260529 §Step 3.3.1 / §D2 / §D17 / §D19)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §D2 / §D17：logsRef 严格 schema SSOT。args 层 zod 校验，handler 不再二次校验
 * 字段格式（仅做 merge / null 合并语义）。
 *
 * - `date` 必填 YYYY-MM-DD ISO 格式（regex 严格）
 * - `tsRange?` 可选 { start, end } epoch ms; refine `start <= end` 反则 reject
 * - `scopes?` 可选 string[] max 32 项 / 单项 max 64 char（数组层 max + 元素 max
 *   两个 zod 约束;handler 不需要再 dedupe — repo merge 内 Set 化）
 * - `note?` 可选 string max 2000 char
 *
 * **§D17 整 obj 全字段 null/undefined → reject**：用 `.refine` 检测至少 1 个字段非
 * null/undefined（注：因 `date` 必填 schema 层已强制非空,refine 实际兜底场景是「caller
 * 把 date 传成 undefined / 空字符串」,zod min(1) 已 reject。但保留 `.refine` 以防未来
 * date 字段改 optional — 当前规则等价 reject empty `{date: ''}` / `{}`）。
 */
export const LOGS_REF_SCHEMA = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD ISO format')
      .describe('Required log date in YYYY-MM-DD format. This is a pointer to logs, not log content.'),
    tsRange: z
      .object({
        start: z.number().int().min(0).describe('Start timestamp in epoch milliseconds.'),
        end: z.number().int().min(0).describe('End timestamp in epoch milliseconds.'),
      })
      .refine((v) => v.start <= v.end, {
        message: 'tsRange.start must be <= tsRange.end',
      })
      .optional()
      .describe('Optional timestamp range inside the log date. start must be <= end.'),
    scopes: z
      .array(z.string().min(1).max(64))
      .max(32, 'scopes max 32 items')
      .optional()
      .describe('Optional log scopes or subsystem names, max 32 items.'),
    note: z
      .string()
      .max(2000)
      .optional()
      .describe('Optional note explaining what the log pointer should help triage.'),
  })
  .refine(
    (v) => v.date != null || v.tsRange != null || v.scopes != null || v.note != null,
    { message: 'logsRef must have at least one non-null field; pass undefined to skip merge' },
  );

/**
 * `report_issue` mcp tool — agent 上报新 issue。返回完整 IssueRecord;主键字段是 `id`
 * （不是 `issueId`）,作为后续同 session append_issue_context / update_issue_status 的 issueId 入参。
 */
export const REPORT_ISSUE_SCHEMA = {
  title: z
    .string()
    .min(1)
    .max(200)
    .describe('Required issue title (1-200 chars).'),
  description: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'Required issue description (1-2000 chars). Include self-contained context so triagers can read without depending on logs.',
    ),
  repro: z
    .string()
    .min(1)
    .max(2000)
    .nullable()
    .optional()
    .describe('Optional reproduction steps (1-2000 chars). Pass null or omit when not provided.'),
  // §D6: kind 软枚举 + free-form fallback — 不用 z.enum 严格校验,非推荐值原样落库 UI 'other' 分组。
  kind: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(
      'Default "follow-up" (your own follow-up work) or "app-bug" (an Agent Deck defect). Any other string is kept as-is and grouped under "other".',
    ),
  severity: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Optional severity. Defaults to "medium"; allowed values are low, medium, or high.'),
  logsRef: LOGS_REF_SCHEMA.optional().describe(
    'Optional pointer to runtime logs, not the log content. `date` is required when logsRef is present; tsRange, scopes, and note are optional.',
  ),
  cwd: z
    .string()
    .max(2048)
    .nullable()
    .optional()
    .describe('Optional cwd. Omit it so the handler fills in the caller session cwd automatically.'),
  labels: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe('Optional free-form tags (max 16 items, each 1-64 chars)'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

/**
 * `append_issue_context` mcp tool — agent 在同一 session 内为已上报 issue 追加现场。
 * source-bound + resolved/软删 reject 详 handler;append 走 issue_appendices 子表不动 description。
 */
export const APPEND_ISSUE_CONTEXT_SCHEMA = {
  issueId: z
    .string()
    .min(1)
    .max(128)
    .describe('Issue `id` returned by report_issue. Only the same source session that reported it can append.'),
  additionalContext: z
    .string()
    .min(1)
    .max(2000)
    .describe('New context to append (1-2000 chars). Appended as a separate note; the original description is untouched.'),
  logsRef: LOGS_REF_SCHEMA.optional().describe(
    'Optional logsRef pointer to merge into the issue. Same shape as report_issue.logsRef; date is always required when logsRef is present.',
  ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

/**
 * `update_issue_status` mcp tool — issue 的源会话或解决会话自助推进 status。
 * 授权边界 source OR resolution session;软删 reject;可选 note 留痕 — 详 handler。
 */
export const UPDATE_ISSUE_STATUS_SCHEMA = {
  issueId: z
    .string()
    .min(1)
    .max(128)
    .describe('Issue `id` to update. Only its source session or resolution session may update it.'),
  status: z
    .enum(['open', 'in-progress', 'resolved'])
    .describe('New issue status. Use "resolved" after fixing it, or "open" / "in-progress" to reopen.'),
  note: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('Optional note kept as an appendix explaining how you fixed it or why you reopened it.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

// Args type infer
export type ReportIssueArgs = z.infer<z.ZodObject<typeof REPORT_ISSUE_SCHEMA>>;
export type AppendIssueContextArgs = z.infer<z.ZodObject<typeof APPEND_ISSUE_CONTEXT_SCHEMA>>;
export type UpdateIssueStatusArgs = z.infer<z.ZodObject<typeof UPDATE_ISSUE_STATUS_SCHEMA>>;

/**
 * Result types（§D19）：handler 返回完整 IssueRecord — 与 task_create / task_update
 * 对称，UI 端 emit 'issue-changed' 时直接拿到全 record（含 appendices 子列表 for created /
 * appended kinds）。
 */
export type ReportIssueResult = IssueRecord;
export type AppendIssueContextResult = IssueRecord;
export type UpdateIssueStatusResult = IssueRecord;
