/**
 * Agent Deck MCP server 7 tool 的 zod schema 集中地。
 * 三 transport（in-process / HTTP / stdio）共享同一份 schema。
 *
 * 历史：从原 src/main/agent-deck-mcp/tools.ts 剥离（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：协议大简化删 reply_message /
 * wait_reply / check_reply 三个 tool 对应的 REPLY_MESSAGE_SCHEMA / WAIT_REPLY_SCHEMA /
 * CHECK_REPLY_SCHEMA。所有发送统一走 send_message + reply_to_message_id；reply 直接
 * 进 lead conversation flow（无需主动 poll）。
 *
 * 字段命名约定：tool args **snake_case**（与 task-manager 既有约定一致），
 * handler 内部消费时再映射 camelCase（不在 schema 层映射，避免 zod 推导出错）。
 */

import { z } from 'zod';

export const SPAWN_SESSION_SCHEMA = {
  adapter: z.enum(['claude-code', 'codex-cli', 'aider', 'generic-pty']),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
      'Must be absolute path',
    ),
  prompt: z.string().min(1).max(100_000),
  team_name: z.string().min(1).max(128).optional(),
  /**
   * 可选 plugin agent body 自动注入（CHANGELOG_76 / plan deep-review-flow-fix D1）：
   * 非空时 in-process / HTTP / stdio handler 都会按 plugin agents registry 找 body file
   * (`<resources>/claude-config/agent-deck-plugin/agents/<name>.md` 经 bundled-assets 缓存)，
   * 把 body 内容作为 caller `prompt` 的前缀注入。免去 lead 自己 cat body 拼字符串。
   * 找不到 / 不是合法 plugin agent name → spawn_session 直接返回 err（避免静默落空 fallback）。
   * 仅 claude-code adapter 有意义；其他 adapter 也允许传但行为相同（adapter 自己决定怎么用）。
   */
  agent_name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/, 'agent_name only allows [a-zA-Z0-9._-]')
    .optional()
    .describe(
      'Optional plugin agent name (e.g. "reviewer-claude" / "reviewer-codex"). When set, the agent body is auto-prepended to `prompt` from bundled-assets registry, so callers do not need to cat & embed the body themselves. Errors when name does not resolve to a known plugin agent. **Frontmatter `model` field auto-extracted and forwarded to SDK** (only effective for claude-code adapter — codex-cli SDK ignores per-thread model override; runtime model decided by ~/.codex/config.toml).',
    ),
  /**
   * REVIEW_31 Bug 4：teammate 显示名（覆盖 session.title 默认 cwd-basename）。
   * UI 列表 / SessionCard / TeamDetail / wire format wireBody 全走 displayName 优先级链
   * （argument > agent_name > 默认 cwd-basename）—— 解决"多 reviewer 都显示同一个 cwd 区分不出"的体验问题。
   */
  display_name: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Optional human-readable display name for the spawned session (e.g. "reviewer-claude · batch A", "patch-coder"). When omitted, falls back to agent_name (if set), otherwise cwd-basename. Becomes session.title (visible in SessionList / TeamDetail) and team_member.display_name (visible in wire format prefix).',
    ),
  permission_mode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .optional()
    .describe(
      'REVIEW_32 HIGH-5: 不传时从 lead session（caller_session_id 对应 row）继承；caller 显式传则覆盖。external caller (caller 不在 sessions 表) 不继承，沿用 adapter 默认。',
    ),
  codex_sandbox: z
    .enum(['workspace-write', 'read-only', 'danger-full-access'])
    .optional()
    .describe('REVIEW_32 HIGH-5: 不传时从 lead 继承；caller 显式传覆盖。'),
  claude_code_sandbox: z
    .enum(['off', 'workspace-write', 'strict'])
    .optional()
    .describe(
      'REVIEW_32 HIGH-5: claude-code adapter 沙盒切档（off / workspace-write / strict）。不传时从 lead 继承（避免 spawn 出的 reviewer-codex 被外层 sandbox 拦 in-process app-server 初始化）。caller 显式传覆盖。',
    ),
  /**
   * REVIEW_36 R2 HIGH-B + MED-C：可选额外 writable roots（仅 claude-code adapter + workspace-write 档生效）。
   * hand_off_session 在外置 worktree 场景下传 `[mainRepo]` 让外置 worktree session 能写 mainRepo plan
   * 文件（user CLAUDE.md §Step 4 plan 完成时更新 frontmatter status=completed 必须写）。
   * 直接调 spawn_session 时一般不传（lead 继承已覆盖大多数场景）。
   */
  extra_allow_write: z
    .array(z.string().min(1).max(4096))
    .max(16)
    .optional()
    .describe(
      'REVIEW_36 R2 HIGH-B + MED-C: claude-code adapter 沙盒额外 writable roots（仅 workspace-write 档生效；strict / off 忽略）。每个绝对路径加进 sandbox.allowWrite 让 SDK 子进程能写。典型：hand_off_session 外置 worktree → 传 [mainRepo] 让 plan 文件路径不被 sandbox 拦。',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_32 HIGH-9: in-process transport 自动 override 真实 session id（无需 caller 显式传）；HTTP / stdio external transport 必须显式传，否则 caller 视为 __external__，需要真实 session 上下文的 tool（spawn/send/reply/wait）会被拒。',
    ),
  parent_session_id: z.string().min(1).max(128).optional(),
};

export const SEND_MESSAGE_SCHEMA = {
  session_id: z.string().min(1).max(128),
  text: z.string().min(1).max(100_000),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_32 HIGH-9: in-process transport 自动 override 真实 session id（无需 caller 显式传）；HTTP / stdio external transport 必须显式传，否则 caller 视为 __external__，需要真实 session 上下文的 tool（spawn/send/reply/wait）会被拒。',
    ),
  // R3.E0 ADR §5.2 amend：multi-team 共享时必填，单 team 共享时可省（自动 resolve）
  team_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Team scope for this message. Required when caller and target share more than one active team; optional when sharing exactly one (auto-resolved). Reject when sharing zero teams.',
    ),
  // plan team-cohesion-fix-20260513 Phase B Step B2：可选对话链关联
  reply_to_message_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Optional: link this message into an existing reply chain (the chain is recorded in DB; lead/teammate will see the reply auto-injected as a user-role message in their conversation flow — no need to poll). Use this when answering a specific message you received; omit when starting a new topic. Per-team scope: original.teamId must match the resolved team_id (cross-team chain rejected).',
    ),
};

export const LIST_SESSIONS_SCHEMA = {
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_32 HIGH-9: in-process transport 自动 override 真实 session id（无需 caller 显式传）；HTTP / stdio external transport 必须显式传，否则 caller 视为 __external__，需要真实 session 上下文的 tool（spawn/send/reply/wait）会被拒。',
    ),
  status_filter: z.enum(['active', 'dormant', 'closed', 'all']).default('active'),
  adapter_filter: z
    .enum(['claude-code', 'codex-cli', 'aider', 'generic-pty'])
    .optional(),
  spawned_by_filter: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Filter to sessions whose spawnedBy === this id. Useful for lead → list children pattern (e.g. deep-code-review SKILL recovers stranded reviewer teammates after lead context reset). No ownership enforcement: any caller can query any spawnedBy id, consistent with list_sessions current single-user app-wide trust model.',
    ),
  limit: z.number().int().min(1).max(200).default(50),
};

export const GET_SESSION_SCHEMA = {
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_32 HIGH-9: in-process transport 自动 override 真实 session id（无需 caller 显式传）；HTTP / stdio external transport 必须显式传，否则 caller 视为 __external__，需要真实 session 上下文的 tool（spawn/send/reply/wait）会被拒。',
    ),
  session_id: z.string().min(1).max(128),
};

export const SHUTDOWN_SESSION_SCHEMA = {
  session_id: z.string().min(1).max(128),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_32 HIGH-9: in-process transport 自动 override 真实 session id（无需 caller 显式传）；HTTP / stdio external transport 必须显式传，否则 caller 视为 __external__，需要真实 session 上下文的 tool（spawn/send/reply/wait）会被拒。',
    ),
  reason: z.string().max(500).optional(),
};

// plan mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.1：archive_plan tool —
// K1 hand-off 自动化 plan 收口（git ff merge / mv plan / commit / worktree remove / branch -D）。
// CHANGELOG_99：default 归档 caller(与 K2 baton 同款语义);plan 收口 = caller 会话使命终结。
// deny external caller（写 git + 删 worktree 高风险）。
export const ARCHIVE_PLAN_SCHEMA = {
  plan_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'plan_id only allows [A-Za-z0-9._-]')
    .describe(
      'Plan id (matches plan file stem and worktree dir name). Used to derive plan file path and commit message. Charset matches EnterWorktree restriction.',
    ),
  worktree_path: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .describe(
      'Absolute path to the plan worktree (e.g. /Users/apple/Repository/foo/.claude/worktrees/<plan_id>). Caller (mcp tool) must have already ExitWorktree-d before calling — handler refuses if process.cwd() is inside this path.',
    ),
  base_branch: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_36 R2 user feedback 修法：caller 不传时优先读 plan frontmatter.base_branch（plan 创建时记录切 worktree 时所在的原分支，feature branch 上开 plan 就是 feature branch 名），frontmatter 也没设 base_branch 字段时 fallback "main"。**强烈建议在 plan frontmatter 显式写 base_branch**，避免 ff-merge 错合到 main 污染主线（feature branch 上跑 plan 但合到 main = worktree 改动从 feature branch 跳过去合主线）。Caller 显式传此参数始终覆盖 frontmatter。',
    ),
  plan_file_path: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Override plan file path. When omitted, handler tries (in order): <main-repo>/.claude/plans/<plan_id>.md, then ~/.claude/plans/<plan_id>.md.',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'In-process transport 自动 override 真实 session id；HTTP / stdio external transport 视为 __external__ 直接 deny（archive_plan 不允许 external caller）。',
    ),
  // CHANGELOG_106：default shutdown caller 是 lead 的 team 内其他 active teammate
  keep_teammates: z
    .boolean()
    .optional()
    .describe(
      'Default false (即 default shutdown caller=lead 同 team 其他 active teammate)。plan 完成 = caller 会话使命终结,team 里没 lead 后 reviewer-claude / reviewer-codex 等 teammate 应一起收口避免孤儿(占内存 + SDK live query)。**仅当 caller 在该 team 是 lead 才 shutdown 同 team 其他成员**(caller 是 teammate 时罕见 baton 不牵连他人);单个 close 失败 warn 不阻塞;helper 自身炸亦 warn 不阻塞 caller archive。Pass `keep_teammates: true` 跳过(罕见: lead 想保留 reviewer 给后续会话继续用,或新 session 显式继承 team 接管 lead 角色)。Detail 见 ok return.teammatesShutdown 字段:{ closed: string[], failed: Array<{sessionId, reason}>, skipped: "caller-not-lead" | "keep-teammates" | null }。',
    ),
};

// plan mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.1：hand_off_session tool —
// （CHANGELOG_99 改名前 `start_next_session`）
// K2 hand-off 自动化「跨会话接力」起新 SDK session（CHANGELOG_99 双模式 spawn_session 包装）。
// 双模式行为:
//   plan-driven 模式 (传 plan_id):读 plan 文件 frontmatter 拿 worktree_path → 校验
//     status=in_progress → 调 spawn_session 起新 SDK session（cwd=mainRepo 默认 / 初始
//     prompt = "按 <plan-abs-path> 接力"，含可选 phase_label 后缀）
//   generic 模式 (不传 plan_id):无需 plan 文件,caller 显式传 prompt + 默认 cwd = caller
//     cwd（让任意会话都能 baton 交给一个新 session）。CHANGELOG_97 baton 语义:default
//     不加 team（caller 显式传 team_name 才启用 lead/teammate 关系）+ default 自动归档 caller。
// CHANGELOG_98 / R2 deep review HIGH-1：spawn 路径走 batonMode 跳 spawn-guards depth check
// + setSpawnLink lateral parentDepth（不 +1），让 N-phase baton 链不撞 maxDepth=3。
// CHANGELOG_99 cwd 失效根治：default cwd 改为 mainRepo（不再是 worktree_path）让新 session
// 行为与 EnterWorktree 模式对齐，避免 archive_plan / git worktree remove 删 worktree 后
// sessionRepo.cwd 失效弯绕。新 session 按 user CLAUDE.md §Step 3 cold-start 流程自己
// EnterWorktree(path: worktreePath) 进 worktree 干活。
// deny external caller（起 SDK session 的 fork bomb 风险，与 spawn_session / archive_plan 同档）。
export const HAND_OFF_SESSION_SCHEMA = {
  // CHANGELOG_99 双模式改造:plan_id 变 optional。
  // - 传 plan_id → plan-driven 模式（现有行为）：读 plan 文件 + 校验 frontmatter status=in_progress
  //   + 自动构造 cold-start prompt = `按 <plan-abs-path> 接力`
  // - 不传 plan_id → generic 模式：无需 plan 文件,caller 显式传 prompt + 默认 cwd = caller cwd
  //   （让任意会话都能 baton 交给一个新 session,不强制 plan-driven workflow 前提）
  plan_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'plan_id only allows [A-Za-z0-9._-]')
    .optional()
    .describe(
      'Plan id (matches plan file stem and worktree dir name). **Optional (CHANGELOG_99 dual-mode)**: when set → plan-driven mode (read frontmatter, validate status=in_progress, auto-construct cold-start prompt "按 <plan-abs-path> 接力"). When omitted → generic mode (caller must pass `prompt`; default cwd = caller cwd; phase_label/plan_file_path ignored). Charset matches EnterWorktree restriction.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(100_000)
    .optional()
    .describe(
      'Cold-start prompt for the new SDK session. **Plan-driven mode (plan_id set)**: ignored — auto-constructed as `按 <plan-abs-path> 接力（Phase: <phase_label>?）`. **Generic mode (no plan_id)**: optional but recommended — defaults to `从上一个会话接力继续工作` if omitted. Use this to give the new session enough context (typical: a paragraph summarizing current work + what to do next).',
    ),
  phase_label: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Optional phase label (e.g. "H3 - Phase 4c Step 4c.1") appended to the cold-start prompt as `（Phase: <label>）`. **Only used in plan-driven mode** — silently ignored in generic mode (CHANGELOG_99). Helps the new session immediately know which phase to start. Omit for plain "按 <plan-abs-path> 接力".',
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
      'Override cwd for the new SDK session. **Plan-driven mode default**: main repo path (CHANGELOG_99 cwd resilience: previously defaulted to plan worktree_path; changed so new session sessionRepo.cwd survives `archive_plan` / `git worktree remove` deletion of the worktree). New session is expected to run `EnterWorktree(path: worktreePath)` itself per user CLAUDE.md §Step 3 cold-start flow. Plan-driven fallback chain: caller args.cwd > resolved.mainRepo > resolved.worktreePath. **REVIEW_36 R2 user feedback / HIGH-3 follow-up**: 约定 worktree (在 mainRepo subtree 内,如 `<main-repo>/.claude/worktrees/<plan-id>`) 走 mainRepo 享 cwd resilience；**外置 worktree** (如 `/tmp/wt` / `/Users/me/elsewhere/wt`) 自动降级走 worktreePath，让 sandbox.allowWrite 自然覆盖外置路径 + handler 自动加 mainRepo 进 extra_allow_write 让 plan 文件可写。**Generic mode default**: caller cwd (looked up from sessionRepo) — falls back to mainRepo if caller cwd is missing.',
    ),
  adapter: z
    .enum(['claude-code', 'codex-cli', 'aider', 'generic-pty'])
    .default('claude-code')
    .describe(
      'Adapter for the new session. Defaults to "claude-code" (the canonical plan-driven workflow runs Claude Code). Set to "codex-cli" / "aider" only when plan explicitly designates a different agent.',
    ),
  team_name: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Optional team_name. **Default: not set** (CHANGELOG_97 baton semantic — hand-off is a one-way baton transfer, the new session works independently and does NOT need a lead/teammate communication relationship with the caller). Pass a custom name only if you specifically want the caller to remain as lead and the new session to be a teammate (rare; use spawn_session if that is the primary intent).',
    ),
  permission_mode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .optional()
    .describe(
      'Permission mode for the new SDK session. When omitted, follows spawn_session defaults (caller_session_id lead inheritance > undefined / adapter default).',
    ),
  codex_sandbox: z
    .enum(['workspace-write', 'read-only', 'danger-full-access'])
    .optional()
    .describe(
      'REVIEW_36 HIGH-2: codex-cli sandbox override for the new SDK session. When omitted, follows spawn_session defaults (caller_session_id lead inheritance > undefined / adapter default = "workspace-write"). Pass explicitly to override (e.g. baton from claude lead to codex-cli with stricter "read-only" for sensitive task). Mirrors spawn_session.codex_sandbox 1:1.',
    ),
  claude_code_sandbox: z
    .enum(['off', 'workspace-write', 'strict'])
    .optional()
    .describe(
      'REVIEW_36 HIGH-2: claude-code OS sandbox override for the new SDK session. When omitted, follows spawn_session defaults (caller_session_id lead inheritance > undefined / settings global). Pass explicitly to override (e.g. baton to a phase that needs "strict" while caller was "workspace-write"). Mirrors spawn_session.claude_code_sandbox 1:1.',
    ),
  /**
   * REVIEW_36 R2 HIGH-B + MED-C：可选额外 writable roots（仅 claude-code adapter + workspace-write 档生效）。
   * Plan-driven 模式下外置 worktree 场景**自动**加 mainRepo（让外置 session 能写 plan 文件），caller 显式
   * 传此字段会与自动计算的 mainRepo 合并去重。直接调 hand_off_session 时一般不传。
   */
  extra_allow_write: z
    .array(z.string().min(1).max(4096))
    .max(16)
    .optional()
    .describe(
      'REVIEW_36 R2 HIGH-B + MED-C: extra writable roots for the new SDK session sandbox (claude-code adapter + workspace-write only). Plan-driven mode + external worktree (worktree not in mainRepo subtree) **auto-adds** mainRepo to let the new session write plan files. Caller-supplied paths are merged with auto-computed mainRepo. Direct callers usually leave this unset.',
    ),
  plan_file_path: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Override plan file path. **Only used in plan-driven mode** — silently ignored in generic mode (CHANGELOG_99). When omitted, handler tries (in order): <main-repo>/.claude/plans/<plan_id>.md (where main-repo is derived from cwd or plan frontmatter), then ~/.claude/plans/<plan_id>.md.',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'In-process transport 自动 override 真实 session id；HTTP / stdio external transport 视为 __external__ 直接 deny（hand_off_session 不允许 external caller）。',
    ),
  parent_session_id: z.string().min(1).max(128).optional(),
  // CHANGELOG_106：default shutdown caller 是 lead 的 team 内其他 active teammate(同 archive_plan 同款语义)
  keep_teammates: z
    .boolean()
    .optional()
    .describe(
      'Default false (即 default shutdown caller=lead 同 team 其他 active teammate)。baton 单向交接 = caller 会话使命终结,team 里没 lead 后 reviewer-claude / reviewer-codex 等 teammate 应一起收口避免孤儿(占内存 + SDK live query)。**仅当 caller 在该 team 是 lead 才 shutdown 同 team 其他成员**(caller 是 teammate 时罕见 baton 不牵连他人);单个 close 失败 warn 不阻塞;helper 自身炸亦 warn 不阻塞 caller archive。Pass `keep_teammates: true` 跳过(典型: 显式传 team_name 让新 session 继承 team 接管 lead 角色)。Detail 见 ok return.teammatesShutdown 字段:{ closed: string[], failed: Array<{sessionId, reason}>, skipped: "caller-not-lead" | "keep-teammates" | null }。',
    ),
  // hand-off-mcp-archive-opt-20260515: caller archive 可选 opt-out。
  // 与 keep_teammates 字段同款 boolean 默认行为 — baton 默认动作可显式 opt-out。
  archive_caller: z
    .boolean()
    .optional()
    .describe(
      'Default true (即 default archive caller — baton 单向交接语义,caller 会话使命终结)。某些场景下 caller 想起新 session 并行做事(更接近 spawn 用法),自己 still alive 协调进度 → pass `archive_caller: false` 跳过 archive,caller 仍 active。典型用例:lead 起多个 hand-off 处理 follow-up 子任务,自己仍想看 reviewer reply / 出 summary;debug 工具想起新 session 实测某 plan 但 caller 仍要继续观察。**注意**: 跳过 archive 时 ok return.archived === "skipped",与 external caller 同款语义值。`archive_caller: false` 与 `keep_teammates: true` 互相独立(可分别 opt-out)。',
    ),
};
export type SpawnSessionArgs = z.infer<z.ZodObject<typeof SPAWN_SESSION_SCHEMA>>;
export type SendMessageArgs = z.infer<z.ZodObject<typeof SEND_MESSAGE_SCHEMA>>;
export type ListSessionsArgs = z.infer<z.ZodObject<typeof LIST_SESSIONS_SCHEMA>>;
export type GetSessionArgs = z.infer<z.ZodObject<typeof GET_SESSION_SCHEMA>>;
export type ShutdownSessionArgs = z.infer<z.ZodObject<typeof SHUTDOWN_SESSION_SCHEMA>>;
export type ArchivePlanArgs = z.infer<z.ZodObject<typeof ARCHIVE_PLAN_SCHEMA>>;
export type HandOffSessionArgs = z.infer<z.ZodObject<typeof HAND_OFF_SESSION_SCHEMA>>;

// =============== Result types (R37 P3-L Step 4.5) ===============
//
// 7 tool 的 ok return shape SSOT（与上方 7 个 args type 对称，让 input/output schema
// 都在 schemas.ts 一处可读）。Handler return 用 `satisfies XxxResult` 做静态字段校验
// 防漂移（typo / 漏字段 / 字段类型错被 TS 拦）。
//
// **设计权衡**：
// - **不抽 typed builder**（保留 helpers.ts 的 untyped `ok(data: unknown)` 8 处统一调用）
//   typed builder 增加 indirection（每个 tool 多一层 wrapper），satisfies 校验已能完成
//   核心收益「字段拼写错被 TS 拦」，wrapper 收益是 marginal 类型文档
// - **HandOffSessionResult extends SpawnSessionResult**：hand-off-session.ts:397 用 `...spawnData`
//   spread 透传 spawn return 字段；用 extends 让 spread 后字段被 satisfies 静态校验
// - **TeammatesShutdownInfo inline 定义**：避免 schemas.ts 依赖 handlers/ 内 implementation
//   type（反向耦合）。若 handlers/shutdown-teammates-on-baton.ts 的 ShutdownTeammatesResult
//   字段漂移，本处 satisfies 会拦下 archive-plan / hand-off return 不匹配（反向加固）。

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
 * baton cleanup phase 1 返回的 teammate shutdown 详情（inline 定义，与
 * handlers/shutdown-teammates-on-baton.ts ShutdownTeammatesResult 字段对齐）。
 *
 * - closed: 成功 close 的 teammate sid 列表（dedup 跨 team 共享同 sid）
 * - failed: close 失败的 teammate（reason 含错误信息），warn 不阻塞
 * - skipped: 'keep-teammates'（caller 显式传） / 'caller-not-lead'（caller 不是 lead） /
 *   null（正常处理含 closed=[] 的 caller=lead 但 team 内无其他 teammate / helper 抛错兜底）
 */
type TeammatesShutdownInfo = {
  closed: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  skipped: 'caller-not-lead' | 'keep-teammates' | null;
};

/** list_sessions ok return shape（list.ts handler）。 */
export interface ListSessionsResult {
  total: number;
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

/** shutdown_session ok return shape（shutdown.ts handler；lifecycle: 'closed' 字面常量约束）。 */
export interface ShutdownSessionResult {
  sessionId: string;
  lifecycle: 'closed';
  alreadyClosed: boolean;
}

/** spawn_session ok return shape（spawn.ts handler；hand-off-session 通过 extends 复用全部字段）。 */
export interface SpawnSessionResult {
  sessionId: string;
  adapter: string;
  cwd: string;
  teamId: string | null;
  teamName: string | null;
  agentName: string | null;
  /** display_name 优先 → agent_name → null（spawn.ts:163 三级 fallback）。 */
  displayName: string | null;
  spawnDepth: number;
  sentAt: number;
  spawnPromptMessageId: string | null;
}

/**
 * archive_plan ok return shape（archive-plan.ts handler；snake_case 字段保持 mcp tool 协议向后兼容）。
 *
 * 字段类型与 archive-plan-impl.ts ArchivePlanImplResult 对齐：
 * - branch_deleted / worktree_removed: string（git 命令 stdout，非 boolean）
 * - final_status: 'completed' literal 由 impl 强制写入 frontmatter status 字段
 */
export interface ArchivePlanResult {
  archived_path: string;
  commit_hash: string;
  branch_deleted: string;
  worktree_removed: string;
  plans_index_appended: boolean;
  final_status: 'completed';
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
  /** CHANGELOG_99: 'plan' = plan-driven 模式（含 worktreePath） / 'generic' = 通用 hand-off。 */
  mode: 'plan' | 'generic';
  /** plan id（plan-driven 模式有值；generic 模式 null）。 */
  planId: string | null;
  /** plan 文件绝对路径（plan-driven 模式有值；generic 模式 null）。 */
  planFilePath: string | null;
  /** worktree 绝对路径（plan-driven 模式有值；generic 模式 null）。 */
  worktreePath: string | null;
  /** plan frontmatter base_branch（plan-driven 模式有值；generic 模式 null）。 */
  baseBranch: string | null;
  /** phase 标签（plan-driven + caller 传 phase_label 时有值；其他 null）。 */
  phaseLabel: string | null;
  /** cold-start prompt 完整字面（caller 可对照 sessionRepo.events 验证 spawn first message 一致）。 */
  initialPrompt: string;
  /** generic 模式下 caller 传了 plan-only 字段（phase_label / plan_file_path）时被忽略的字段名数组；plan 模式始终空。 */
  ignoredFields: string[];
  /** caller archive 三态：'ok'=成功 / 'failed'=warn-only 不阻塞 / 'skipped'=external caller 或 caller 显式传 archive_caller=false。 */
  archived: 'ok' | 'failed' | 'skipped';
  /** baton cleanup phase 1 详情（与 archive_plan 同款）。 */
  teammatesShutdown: TeammatesShutdownInfo;
}
