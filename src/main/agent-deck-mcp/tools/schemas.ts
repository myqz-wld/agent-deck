/**
 * Agent Deck MCP server 7 tool 的 zod schema 集中地。
 * 三 transport（in-process / HTTP / stdio）共享同一份 schema。
 *
 * 历史：从原 src/main/agent-deck-mcp/tools.ts 剥离（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
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
      'Optional plugin agent name (e.g. "reviewer-claude" / "reviewer-codex"). When set, the agent body is auto-prepended to `prompt` from bundled-assets registry, so callers do not need to cat & embed the body themselves. Errors when name does not resolve to a known plugin agent.',
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
      'Optional: link this message as a reply to an existing message in the same team. The reply forms a conversation chain queryable via wait_reply({message_id}). Use this for "I am replying to message X" semantics; for new topics omit it. The dedicated reply_message tool is a more ergonomic alias that auto-resolves to_session_id and team_id from the original message.',
    ),
};

export const WAIT_REPLY_SCHEMA = {
  // plan team-cohesion-fix-20260513 Phase B Step B4：wait_reply 重定义为「等某条 msg 的 reply」
  // —— 不再是事件流投影，直接 query messages 表 + universal-message-watcher event listener。
  message_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Wait for a reply to this specific message id (returned by send_message / reply_message). The wait resolves when a message with reply_to_message_id = this id is delivered (DB query + event listener).',
    ),
  nudge_text: z
    .string()
    .min(1)
    .max(100_000)
    .optional()
    .describe(
      'Optional: if no reply arrives within nudge_after_ms, automatically send a nudge message (text body) to the recipient as a "are you there" reminder. The nudge is itself a reply to the original message (reply_to_message_id chains). Useful when the other side may have forgotten to call reply_message.',
    ),
  nudge_after_ms: z
    .number()
    .int()
    .min(5_000)
    .max(1_800_000)
    .optional()
    .describe(
      'How long (ms) to wait before sending the nudge. Defaults to half of timeout_ms (clamped 5_000 ~ 1_800_000). Ignored when nudge_text is omitted.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(1_800_000)
    .default(600_000)
    .describe(
      'Total timeout (1s ~ 30min). Returns { reply: null, timedOut: true } when exceeded. Default 10min covers normal review turns; deep multi-file reviews / heavy reasoning may need 15-30min — pass a larger value explicitly.',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_32 HIGH-9: in-process transport 自动 override 真实 session id（无需 caller 显式传）；HTTP / stdio external transport 必须显式传，否则 caller 视为 __external__，需要真实 session 上下文的 tool（spawn/send/reply/wait）会被拒。',
    ),
};

// plan mcp-bug-and-feature-batch-20260513 Phase 1 Step 1.3：check_reply 短查询 tool —
// wait_reply 的非阻塞配对版。lead 调 check_reply(message_id) 立即返回 { reply, timedOut: false }
// 或 { reply: null, timedOut: false }，不挂 listener / 不起 nudge timer / 不阻塞 lead 处理
// 其他 user input。lead 自己 poll 周期由其 reasoning 决定（与 wait_reply 互补）。
export const CHECK_REPLY_SCHEMA = {
  message_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Check whether a reply to this message id has arrived (returned by send_message / reply_message). Returns immediately with { reply: { messageId, text, sentAt, fromSessionId } | null, timedOut: false } — never blocks. Use this when you want to retain the ability to handle other user input while polling for a reply (vs wait_reply which blocks the lead session).',
    ),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'In-process transport 自动 override 真实 session id；HTTP / stdio external transport 必须显式传。',
    ),
};

export const REPLY_MESSAGE_SCHEMA = {
  reply_to_message_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'The id of the original message you are replying to (returned by send_message / wait_reply).',
    ),
  text: z.string().min(1).max(100_000).describe('Reply body (1-100KB).'),
  caller_session_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'REVIEW_32 HIGH-9: in-process transport 自动 override 真实 session id（无需 caller 显式传）；HTTP / stdio external transport 必须显式传，否则 caller 视为 __external__，需要真实 session 上下文的 tool（spawn/send/reply/wait）会被拒。',
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

// z.infer 友好的 args 类型 —— handler 直接消费。
// SDK 的 InferShape<Schema> 等价 z.infer<z.ZodObject<typeof Schema>>。
export type SpawnSessionArgs = z.infer<z.ZodObject<typeof SPAWN_SESSION_SCHEMA>>;
export type SendMessageArgs = z.infer<z.ZodObject<typeof SEND_MESSAGE_SCHEMA>>;
export type WaitReplyArgs = z.infer<z.ZodObject<typeof WAIT_REPLY_SCHEMA>>;
export type CheckReplyArgs = z.infer<z.ZodObject<typeof CHECK_REPLY_SCHEMA>>;
export type ReplyMessageArgs = z.infer<z.ZodObject<typeof REPLY_MESSAGE_SCHEMA>>;
export type ListSessionsArgs = z.infer<z.ZodObject<typeof LIST_SESSIONS_SCHEMA>>;
export type GetSessionArgs = z.infer<z.ZodObject<typeof GET_SESSION_SCHEMA>>;
export type ShutdownSessionArgs = z.infer<z.ZodObject<typeof SHUTDOWN_SESSION_SCHEMA>>;
