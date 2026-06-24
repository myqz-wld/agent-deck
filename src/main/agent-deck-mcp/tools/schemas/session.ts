import { z } from 'zod';
import { SDK_READ_CALLER_SESSION_ID_DESCRIPTION, SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';

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
    before: DIFF_REVIEW_TEXT.describe(
      'Original content for the left side of the two-column presentation. Use the actual before fragment as the primary comparison content; concise explanatory annotations may be included when helpful for a walkthrough and should be clearly marked when they are not part of the patch.',
    ),
    after: DIFF_REVIEW_TEXT.describe(
      'Proposed content for the right side of the two-column presentation. Use the actual after fragment as the primary comparison content; concise explanatory annotations may be included when helpful for a walkthrough and should be clearly marked when they are not part of the patch.',
    ),
    beforeLabel: z.string().min(1).max(80).optional().describe('Optional label for the original side. Defaults should be UI-owned, not agent-owned.'),
    afterLabel: z.string().min(1).max(80).optional().describe('Optional label for the proposed side. Defaults should be UI-owned, not agent-owned.'),
    unifiedDiff: DIFF_REVIEW_TEXT.optional().describe(
      'Optional unified diff shown as supporting context when before/after panes need file headers, hunk markers, or broader surrounding lines. It supplements before and after; do not pass it instead of before and after.',
    ),
  })
  .strict();

export const DIFF_REVIEW_CONFLICT_FRAGMENT_SCHEMA = z
  .object({
    ours: DIFF_REVIEW_TEXT.describe('Current/ours content for the conflict pane. Concise explanatory annotations may be included when helpful for a walkthrough and should be clearly marked when they are not part of the patch.'),
    theirs: DIFF_REVIEW_TEXT.describe('Incoming/theirs content for the conflict pane. Concise explanatory annotations may be included when helpful for a walkthrough and should be clearly marked when they are not part of the patch.'),
    resolution: DIFF_REVIEW_TEXT.describe('Proposed final resolved content for the user to confirm or revise. Concise explanatory annotations may be included when helpful for a walkthrough and should be clearly marked when they are not part of the patch.'),
    base: DIFF_REVIEW_TEXT.optional().describe(
      'Optional common ancestor content, shown only when useful for understanding the resolution. Concise explanatory annotations may be included when helpful for a walkthrough and should be clearly marked when they are not part of the patch.',
    ),
    oursLabel: z.string().min(1).max(80).optional().describe('Optional display label for the current/ours pane. Defaults should be UI-owned, not agent-owned.'),
    theirsLabel: z.string().min(1).max(80).optional().describe('Optional display label for the incoming/theirs pane. Defaults should be UI-owned, not agent-owned.'),
    resolutionLabel: z.string().min(1).max(80).optional().describe('Optional display label for the resolution pane. Defaults should be UI-owned, not agent-owned.'),
    baseLabel: z.string().min(1).max(80).optional().describe('Optional display label for the common-base pane. Defaults should be UI-owned, not agent-owned.'),
  })
  .strict();

export const REQUEST_DIFF_REVIEW_SCHEMA = {
  mode: z
    .enum(['pr', 'merge-conflict'])
    .describe(
      'Presentation layout and payload selector. Use "pr" for a two-column before/after presentation and provide only `pr`; use "merge-conflict" for an ours/theirs/resolution presentation and provide only `conflict`.',
    ),
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
    .describe(
      'Optional focused presentation instructions or acceptance criteria shown with the diff, such as risk areas, intended behavior, or specific questions for the user. In a step-by-step walkthrough, use it to scope what the user should confirm for the current fragment and to explain relevant fields, callers, functions, logic, or purpose.',
    ),
  rationale: z
    .string()
    .min(1)
    .max(40_000)
    .describe(
      'Short explanation shown above the diff so the user understands what they are confirming and why this fragment is being presented.',
    ),
  pr: DIFF_REVIEW_PR_FRAGMENT_SCHEMA.optional().describe('Two-column PR-style diff payload. Required when mode="pr"; omit when mode="merge-conflict". Use this payload for each PR-style walkthrough fragment.'),
  conflict: DIFF_REVIEW_CONFLICT_FRAGMENT_SCHEMA.optional().describe(
    'Merge-conflict presentation payload. Required when mode="merge-conflict"; omit when mode="pr". Use this payload for each conflict walkthrough fragment.',
  ),
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

export type SendMessageArgs = z.infer<z.ZodObject<typeof SEND_MESSAGE_SCHEMA>>;
export type RequestPlanReviewArgs = z.infer<z.ZodObject<typeof REQUEST_PLAN_REVIEW_SCHEMA>>;
export type RequestDiffReviewArgs = z.infer<z.ZodObject<typeof REQUEST_DIFF_REVIEW_SCHEMA>>;
export type ListSessionsArgs = z.infer<z.ZodObject<typeof LIST_SESSIONS_SCHEMA>>;
export type GetSessionArgs = z.infer<z.ZodObject<typeof GET_SESSION_SCHEMA>>;
export type ShutdownSessionArgs = z.infer<z.ZodObject<typeof SHUTDOWN_SESSION_SCHEMA>>;

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
