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
  adapter: z.enum(['claude-code', 'codex-cli']),
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
    .describe(
      'REVIEW_32 HIGH-5: 不传时从 lead 继承；caller 显式传覆盖。**P5 Round 1 reviewer-codex M3 修法 (clarify 契约边界)**：reviewer-* teammate spawn 路径 (agent_name="reviewer-claude" / "reviewer-codex") 由 options-builder 强制 spread "workspace-write" (plan §不变量 6 — reviewer body 内 Bash/shell 工具需读源码 + 写中间文件)，caller 显式传 codex_sandbox 会被 reviewer-* unsafe default override + 主进程 console.warn 提示。如需严格 read-only 给 reviewer，目前不支持 — reviewer body 设计依赖 workspace-write。',
    ),
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
    .enum(['claude-code', 'codex-cli'])
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
//
// **plan hand-off-session-adopt-teammates-20260520 Phase 3 双层命名**(D2 + N4 + Round 3 MED-2):
// - `ARCHIVE_PLAN_SHAPE` (ZodRawShape) 给 `tool()` 注册 + 三 transport(in-process / HTTP /
//   stdio)的现有接口用(SDK tool() 接受 raw shape 不能直接接受 z.object 包装的 ZodObject)
// - `ARCHIVE_PLAN_ARGS_SCHEMA = z.object(SHAPE).strict()` 给 handler / type / test 用,
//   strict 模式让 unknown keys (如已废弃的 opt-out 字段) 在 parse 时直接 throw
//   `unrecognized_keys` 既挡 caller 从外部传旧字段误以为生效,也作为 schema breaking change 守门。
export const ARCHIVE_PLAN_SHAPE = {
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
      'Override plan file path. When omitted, handler tries (in order): <main-repo>/.claude/plans/<plan_id>.md, then <main-repo>/plans/<plan_id>.md, then ~/.claude/plans/<plan_id>.md. **stem 约束**(impl-level refine,follow-up 20260515): plan_file_path 文件名 stem(去 .md 后缀)必须等于 plan_id — 否则 archive_plan reject(防 archived path / INDEX key 派生与 caller 给的文件 stem 脱节导致 silent unlink 风险)。',
    ),
  changelog_id: z
    .string()
    .regex(
      /^\s*\d+(\s*,\s*\d+)*\s*$/,
      'changelog_id must be a digit (e.g. "122") or comma-separated digits (e.g. "121,122" / "121, 122") matching CHANGELOG_X.md naming; whitespace around digits/commas allowed',
    )
    .optional()
    .describe(
      'Optional changelog reference(s) for plans/INDEX.md smart update (followup 20260515 (b)+(c))。caller 在 archive_plan 之前已经写完 CHANGELOG_X.md 并 commit,此处显式传 X 数字(如 "122")或多个逗号分隔(如 "121,122" 或 "121, 122" — R1 fix MED-3 放松 regex 容空格,与 helper trim 行为对齐)。impl 拼成 markdown link `[X](../changelog/CHANGELOG_X.md)` 写入 INDEX 第 3 列「关联 changelog」。**caller 不传时**:smart update existing 4-列 row 保留原 changelog 列;旧 2 列 row 或新 append 行用 `—` placeholder(不强制清空已有,避免数据丢失)。',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'In-process transport 自动 override 真实 session id；HTTP / stdio external transport 视为 __external__ 直接 deny（archive_plan 不允许 external caller）。',
    ),
  // plan hand-off-session-adopt-teammates-20260520 Phase 3：删除 baton-cleanup
  // teammate-shutdown 的 opt-out 字段 (D2 + N4 hard gate 1)。default baton-cleanup phase 1
  // 仍 shutdown caller=lead 同 team 其他 active teammate;adopt 路径走 hand_off_session
  // 的 adopt_teammates: true(详 plan Phase 4)显式接管 teammate。archive_plan 不再支持
  // opt-out,简化语义。
};

// =============== HAND_OFF_SESSION (K2 hand-off automation) ===============

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
//
// **plan hand-off-session-adopt-teammates-20260520 Phase 3 双层命名**(D2 + N4 + Round 3 MED-2):
// - `HAND_OFF_SESSION_SHAPE` (ZodRawShape) 给 `tool()` 注册 + 三 transport 的现有接口用
// - `HAND_OFF_SESSION_ARGS_SCHEMA = z.object(SHAPE).strict()` 给 handler / type / test 用,
//   strict 模式让 unknown keys (如已废弃的 opt-out 字段) 在 parse 时直接 throw `unrecognized_keys`
// - N2.c invariant (adopt_teammates: true 与 args.team_name 互斥) 在 Phase 4 加 .refine()
export const HAND_OFF_SESSION_SHAPE = {
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
    .enum(['claude-code', 'codex-cli'])
    .default('claude-code')
    .describe(
      'Adapter for the new session. Defaults to "claude-code" (the canonical plan-driven workflow runs Claude Code). Set to "codex-cli" only when plan explicitly designates a different agent.',
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
  // plan hand-off-session-adopt-teammates-20260520 Phase 3：删除 baton-cleanup
  // teammate-shutdown 的 opt-out 字段 (D2 + N4 hard gate 1)。default baton-cleanup phase 1
  // 仍 shutdown caller=lead 同 team 其他 active teammate;adopt 路径走 adopt_teammates: true
  // (详 plan Phase 4)显式接管 teammate。hand_off_session 不再支持 opt-out,简化语义。
  // hand-off-mcp-archive-opt-20260515: caller archive 可选 opt-out。
  archive_caller: z
    .boolean()
    .optional()
    .describe(
      'Default true (即 default archive caller — baton 单向交接语义,caller 会话使命终结)。某些场景下 caller 想起新 session 并行做事(更接近 spawn 用法),自己 still alive 协调进度 → pass `archive_caller: false` 跳过 archive,caller 仍 active。典型用例:lead 起多个 hand-off 处理 follow-up 子任务,自己仍想看 reviewer reply / 出 summary;debug 工具想起新 session 实测某 plan 但 caller 仍要继续观察。**注意**: 跳过 archive 时 ok return.archived === "skipped",与 external caller 同款语义值。`archive_caller: false` 与其他 opt-out 字段(若未来新增)互相独立。',
    ),
};

// plan codex-handoff-team-alignment-20260518 P1 Step 1.2 / D2 + 不变量 5：
// enter_worktree / exit_worktree MCP tool — 给 codex / 跨 adapter caller 提供 claude builtin
// EnterWorktree / ExitWorktree 的等价能力,让 archive_plan 预检走 4 态分流时认得跨 adapter
// 路径(详 P1 Step 1.4 archive-plan-impl.ts 4 态分流)。
//
// 设计要点:
// - enter_worktree 走 `git worktree add -b worktree-<plan_id> <worktree_path>` 显式 HEAD 作 base
//   (避开 claude builtin v2.1.112 stale base bug — 详 user CLAUDE.md §Step 1 末 callout)
// - enter_worktree 成功后 setCwdReleaseMarker(callerSid, worktreePath) — 让 archive_plan
//   预检识别「caller 显式持有该 worktree」放过(状态 2)
// - exit_worktree 走 `git worktree remove` + `git branch -D` + clearCwdReleaseMarker(callerSid)
// - 字段对称 archive_plan / hand_off_session 既有约定(snake_case args / 4096 max path / 128 max plan_id)
// - deny external caller(写 git + setMarker 是 per-session 状态,需要真实 caller_session_id)
export const ENTER_WORKTREE_SCHEMA = {
  plan_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'plan_id only allows [A-Za-z0-9._-]')
    .describe(
      'Plan id (matches plan file stem, derives branch name `worktree-<plan_id>` and default worktree path `<main-repo>/.claude/worktrees/<plan_id>/`). Charset aligned with archive_plan / hand_off_session.',
    ),
  worktree_path: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional override for worktree absolute path. When omitted, derived as `<main-repo>/.claude/worktrees/<plan_id>/` (main-repo from caller sessionRepo.cwd via `git rev-parse --show-toplevel`). Caller-supplied path overrides default; handler still uses it verbatim as branch checkout target.',
    ),
  base_commit: z
    .string()
    .min(7)
    .max(64)
    .regex(/^[0-9a-f]+$/i, 'base_commit must be hex SHA (≥7 chars)')
    .optional()
    .describe(
      'Optional explicit base commit SHA. Highest priority in base resolution chain (plan D2): caller args.base_commit > caller args.base_branch > plan frontmatter base_commit > plan frontmatter base_branch > HEAD. Use to lock new worktree to a specific commit (e.g. for reproducing historical state).',
    ),
  base_branch: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Optional base branch name (resolves to that branch HEAD as base commit). Lower priority than base_commit but higher than plan frontmatter / HEAD fallback (plan D2). Useful when caller wants to branch off a non-current branch without manually resolving SHA.',
    ),
  plan_file_path: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Optional plan file absolute path (for frontmatter base_commit / base_branch fallback chain when caller args do not specify base). When omitted, handler tries (in order): <main-repo>/.claude/plans/<plan_id>.md, then <main-repo>/plans/<plan_id>.md, then ~/.claude/plans/<plan_id>.md (same fallback chain as archive_plan).',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'In-process transport 自动 override 真实 session id；HTTP / stdio external transport 视为 __external__ 直接 deny（enter_worktree 不允许 external caller — git worktree add 是写操作 + setCwdReleaseMarker 是 per-session 状态需真实 caller sid）。',
    ),
};

export const EXIT_WORKTREE_SCHEMA = {
  action: z
    .enum(['keep', 'remove'])
    .describe(
      '"keep" 留 worktree 目录与 branch 不动(典型 plan in_progress 中途 hand-off 切会话场景 — 新 session cold-start EnterWorktree(path:...) 复用同一 worktree)；"remove" 删 worktree 目录 + branch(典型 plan 完成或中止收口场景)。两种 action 都会 clearCwdReleaseMarker(callerSid)清 marker。',
    ),
  worktree_path: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional override for worktree absolute path to exit. When omitted, derived from caller sessionRepo.cwd_release_marker (caller must have called enter_worktree first to set the marker — otherwise reject). Use override only when caller knows the path but lost marker (e.g. session restart between enter_worktree and exit_worktree).',
    ),
  discard_changes: z
    .boolean()
    .optional()
    .describe(
      'Only meaningful with action="remove". If worktree has uncommitted files / commits not on base branch, tool refuses unless this is true (matches claude builtin ExitWorktree semantic — protects against accidentally losing work). action="keep" 时此字段忽略(留下来的 worktree 改动一定保留)。',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'In-process transport 自动 override 真实 session id；HTTP / stdio external transport 视为 __external__ 直接 deny（exit_worktree 不允许 external caller — git worktree remove 是写操作 + clearCwdReleaseMarker 是 per-session 状态需真实 caller sid）。',
    ),
};

// plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.3a / D4 F1c：
// shutdown_baton_teammates tool — escape hatch 让 caller 手工归档 plan 后补跑 baton-cleanup
// phase 1（teammate shutdown）。
//
// **场景**：archive_plan tool precheck 失败（mainRepo dirty 撞 archive-critical 路径 / cwd
// resilience guard 等）→ caller 走 user CLAUDE.md §Step 4 5 步手工归档绕过 archive_plan tool
// → runBatonCleanup phase 1 没被调到 → 同 team teammate（reviewer-claude / reviewer-codex 等）
// 自然衰减成 dormant 但**没** closed,占内存 + SDK live query。本 tool 让 caller 显式补跑 phase 1
// （仅 teammate shutdown,不归档 caller — 本 tool 设计就是「caller 已经手工归档 / 不归档，
// 仅恢复 baton-cleanup teammate 收口语义」）。
//
// **行为契约**：
// - 复用 shutdownTeammatesOnBaton helper Phase 1（findActiveMembershipsBySession +
//   listActiveMembers + closeFn 串行调度）— 与 archive_plan / hand_off_session default 同款行为
// - **不**调 phase 2 archive caller（caller 决定何时 archive；典型场景 caller 已手工归档完毕）
// - findMemberships 返空（caller 不在任何 team 是 lead）→ error + hint，**不** silent return
//   success（plan §F1c 明确 buggy 行为：escape hatch 是 caller 显式请求 cleanup，no-op 误导）
// - deny external（写 sessionManager.close 是高风险 + 需要真实 caller_session_id 才能反查 lead 关系）
//
// **与 archive_plan 的边界**：
// - archive_plan 是 plan 收口 tool（git ff-merge / mv plan / commit / git worktree remove）+
//   default baton-cleanup phase 1+2(plan hand-off-session-adopt-teammates-20260520 Phase 3
//   删 baton-cleanup teammate-shutdown 的 opt-out 字段,phase 1 不再支持 opt-out)
// - shutdown_baton_teammates 是「补跑 phase 1」的独立 tool，不做 git/fs 归档操作
//
// 字段对称 archive_plan / hand_off_session 既有约定（snake_case args / 128 max plan_id）。
export const SHUTDOWN_BATON_TEAMMATES_SCHEMA = {
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'In-process transport 自动 override 真实 session id；HTTP / stdio external transport 视为 __external__ 直接 deny（shutdown_baton_teammates 不允许 external caller — sessionManager.close 是写操作 + caller=lead 反查需要真实 caller_session_id）。',
    ),
  plan_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/, 'plan_id only allows [A-Za-z0-9._-]')
    .optional()
    .describe(
      'Optional plan id（仅供 console.warn / event 前缀辨识本次 escape hatch 调用属哪个 plan 收口场景）。本 tool 不读 plan 文件 / 不读 frontmatter / 不依赖 plan 状态（caller 已手工归档完成时 plan 已 mv 走，传 plan_id 仍可辨识）。Charset 与 archive_plan / hand_off_session 对称。',
    ),
};

export type SpawnSessionArgs = z.infer<z.ZodObject<typeof SPAWN_SESSION_SCHEMA>>;
export type SendMessageArgs = z.infer<z.ZodObject<typeof SEND_MESSAGE_SCHEMA>>;
export type ListSessionsArgs = z.infer<z.ZodObject<typeof LIST_SESSIONS_SCHEMA>>;
export type GetSessionArgs = z.infer<z.ZodObject<typeof GET_SESSION_SCHEMA>>;
export type ShutdownSessionArgs = z.infer<z.ZodObject<typeof SHUTDOWN_SESSION_SCHEMA>>;

// plan hand-off-session-adopt-teammates-20260520 Phase 3 双层命名 (D2 + N4 + Round 3 MED-2):
// - SHAPE = ZodRawShape 给 `tool()` 注册 + 三 transport 的现有接口 (上方已 export)
// - ARGS_SCHEMA = z.object(SHAPE).strict() 给 handler / type / test 用
//   strict 模式让 unknown keys (如已废弃的 opt-out 字段) 在 parse 时直接 throw
//   `unrecognized_keys` (Phase 4 加 .refine() 实现 N2.c invariant)
// - type infer 用 strict 版本 (旧的 z.ZodObject<typeof SHAPE> 推导出的是 passthrough,
//   不能 reject unknown keys; strict 版才匹配 handler 实际 parse 路径)
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
 * - skipped: 'caller-not-lead'（caller 不是 lead） / 'adopt-keep-implicit'（plan
 *   hand-off-session-adopt-teammates-20260520 Phase 4 — adopt_teammates: true 时
 *   teammate 由 swapLead 接管不 shutdown） / null（正常处理含 closed=[] 的 caller=lead
 *   但 team 内无其他 teammate / helper 抛错兜底）
 */
type TeammatesShutdownInfo = {
  closed: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  skipped: 'caller-not-lead' | 'adopt-keep-implicit' | null;
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
  /**
   * archive-plan-tool-ux-followup-20260515 (b)+(c):plansIndexAppended boolean → plansIndexAction
   * 四态 enum,让 caller 区分 INDEX 行真正发生的事情:
   * - 'created':INDEX 文件不存在,创建带 4 列 header 的初始文件 + 第一行
   * - 'appended':INDEX 已存在但无本 plan_id 行,append 一行 4 列 row
   * - 'updated':INDEX 已存在且有本 plan_id 行 → smart update canonical rewrite 4 列
   *   (status=completed + changelog 列 + description 列)
   * - 'unchanged':smart update 后内容与原行完全相同(罕见 idempotent)
   */
  plans_index_action: 'created' | 'appended' | 'updated' | 'unchanged';
  final_status: 'completed';
  /**
   * archive-plan-tool-ux-followup-20260515 HIGH-2 (双方独立 HIGH 共识 — silent override 防覆盖
   * 走 warn 而非 reject):non-fatal warning 列表。典型场景:
   * - `.claude/plans/<id>.md` 与 `<main-repo>/plans/<id>.md` 同 id 双存,fallback 选 .claude/
   *   plans/ 后会覆盖 plans/ 历史 completed archive → 加 warning 让 caller 看到
   * 调用方应在 ok return display 时把 warnings 列出来,而非吞掉。空数组表示无 warning。
   */
  warnings: string[];
  /**
   * **R3 follow-up (spike-reports/ 归档流程缺口)**: spike artifacts 自动归档结果。
   *
   * - `null`: plan 无 spike (`<plan-dir>/spike-reports/` 不存在),skip
   * - `{ src_path, dst_path }`: spike-reports/ 成功 mv 到 `<main-repo>/plans/<plan-id>/spike-reports/`
   *   (plan .md 同名子目录,与 plan .md 平级),入 git 归档 commit
   *
   * mv 失败 (EXDEV 跨 fs / perm) 时不阻塞 ok return,落 warnings 数组让 caller 手工
   * `mkdir -p && mv && git add+commit --amend` 补归档。
   */
  spike_reports_archived: { src_path: string; dst_path: string } | null;
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

/**
 * enter_worktree ok return shape (handlers/enter-worktree.ts)。
 *
 * - worktreePath: 实际创建 / 进入的 worktree 绝对路径（caller 不传 args.worktree_path 时由
 *   handler 派生 `<main-repo>/.claude/worktrees/<plan_id>/`,有传则等于 args.worktree_path)
 * - branchName: 创建的 branch 名(`worktree-<plan_id>` 固定模式)
 * - baseCommit: 实际作为 base 的 commit SHA(40 字符 hex)
 * - baseSource: 5 态枚举表明 base 是从哪个来源 resolved(plan D2 优先级链)
 *   - 'arg-base-commit': caller args.base_commit 显式传
 *   - 'arg-base-branch': caller args.base_branch 显式传,handler resolve 到 HEAD
 *   - 'frontmatter-base-commit': plan frontmatter base_commit 字段
 *   - 'frontmatter-base-branch': plan frontmatter base_branch 字段
 *   - 'head': 都没传,fallback 主仓库 HEAD（标准走法）
 * - markerSet: setCwdReleaseMarker 成功标 true(几乎一定 true,失败 handler 应已 reject)
 */
export interface EnterWorktreeResult {
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  baseSource:
    | 'arg-base-commit'
    | 'arg-base-branch'
    | 'frontmatter-base-commit'
    | 'frontmatter-base-branch'
    | 'head';
  markerSet: boolean;
}

/**
 * exit_worktree ok return shape (handlers/exit-worktree.ts)。
 *
 * - worktreePath: 实际处理的 worktree 绝对路径(从 args 或从 cwd_release_marker 解析)
 * - action: 'keep' | 'remove' 镜像 args
 * - branchDeleted: action='remove' 时为 true / 'keep' 时永远 false
 * - worktreeRemoved: action='remove' 时为 true / 'keep' 时永远 false
 * - markerCleared: clearCwdReleaseMarker 成功标 true(几乎一定 true,失败 handler 应已 reject)
 */
export interface ExitWorktreeResult {
  worktreePath: string;
  action: 'keep' | 'remove';
  branchDeleted: boolean;
  worktreeRemoved: boolean;
  markerCleared: boolean;
}

/**
 * shutdown_baton_teammates ok return shape (handlers/shutdown-baton-teammates.ts)。
 *
 * 与 archive_plan / hand_off_session 的 `teammatesShutdown` 字段子集对齐 — 仅含 baton-cleanup
 * phase 1（teammate shutdown）相关字段，**不**含 phase 2 archive caller 相关 `archived` 字段。
 *
 * - closed: 成功 close 的 teammate sid 列表（dedup 跨 team 共享同 sid）
 * - failed: close 失败的 teammate（含 reason），warn 不阻塞
 * - skipped: 'caller-not-lead' = caller 不在任何 team 是 lead → escape hatch reject 走 error 路径
 *   不在 ok return（详 handler 错误契约）；ok return 中 skipped 永远是 null（找到 lead 关系
 *   并跑完 phase 1 才算成功 ok）。本 escape hatch 设计就是「显式补跑 phase 1」,没有
 *   teammate 接管 / opt-out 字段(plan hand-off-session-adopt-teammates-20260520 Phase 3
 *   删 baton-cleanup teammate-shutdown opt-out 字段后,'adopt-keep-implicit' 也不出现 —
 *   本 tool 调用方已经手工归档不走 adopt 路径)
 * - planId: 透传 args.plan_id，方便 caller 关联本次 escape hatch 调用属哪个 plan 收口场景
 */
export interface ShutdownBatonTeammatesResult {
  closed: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  skipped: null;
  planId: string | null;
}
