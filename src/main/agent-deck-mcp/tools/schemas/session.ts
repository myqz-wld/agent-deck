import { z } from 'zod';
import type { AgentEvent } from '@shared/types';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';

export const SEND_MESSAGE_SCHEMA = {
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .describe('Target session id to receive the message. When replying, use the `<senderSid>` from the `[msg <id>][sid <senderSid>]` wire prefix of the received message. Dormant targets resume automatically; closed targets reject, and the caller cannot send to itself.'),
  text: z
    .string()
    .min(1)
    .max(MAX_USER_MESSAGE_LENGTH)
    .describe('Message body to inject as a user-role turn in the target session. Include enough context for the receiver to act without polling.'),
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
};

const DIFF_REVIEW_TEXT = z.string().max(100_000);
const DIFF_REVIEW_ANNOTATION_TEXT = z.string().min(1).max(4_000);

export const DIFF_REVIEW_ANNOTATION_SCHEMA = z
  .object({
    pane: z
      .enum(['before', 'after', 'both', 'base', 'ours', 'theirs', 'resolution'])
      .describe(
        'Pane that should display this annotation. Use before/after/both with mode="pr"; use base/ours/theirs/resolution with mode="merge-conflict".',
      ),
    line: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe(
        'Optional 1-based line number in the selected pane. The annotation is shown after that displayed line; use 0 or omit it to show the card before the first line.',
      ),
    title: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Optional short heading for this annotation. Omit it when the body is self-explanatory.'),
    body: DIFF_REVIEW_ANNOTATION_TEXT.describe(
      'Concise pane-specific explanation, such as field meaning, caller impact, logic, risk, or purpose. Do not include source content that belongs in the source pane.',
    ),
  })
  .strict();

export const DIFF_REVIEW_PR_FRAGMENT_SCHEMA = z
  .object({
    before: DIFF_REVIEW_TEXT.describe(
      'Exact original content for the left side of the two-column presentation. Use the actual before fragment as the primary comparison content; do not include explanatory prose or annotations in this source pane.',
    ),
    after: DIFF_REVIEW_TEXT.describe(
      'Exact proposed content for the right side of the two-column presentation. Use the actual after fragment as the primary comparison content; do not include explanatory prose or annotations in this source pane.',
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
    ours: DIFF_REVIEW_TEXT.describe('Exact current/ours content for the conflict pane. Do not include explanatory prose or annotations in this source pane.'),
    theirs: DIFF_REVIEW_TEXT.describe('Exact incoming/theirs content for the conflict pane. Do not include explanatory prose or annotations in this source pane.'),
    resolution: DIFF_REVIEW_TEXT.describe('Exact proposed final resolved content for the user to confirm or revise. Do not include explanatory prose or annotations in this source pane.'),
    base: DIFF_REVIEW_TEXT.optional().describe(
      'Optional exact common ancestor content, shown only when useful for understanding the resolution. Do not include explanatory prose or annotations in this source pane.',
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
      'Optional confirmation instructions or acceptance criteria shown with the diff, such as risk areas, intended behavior, or specific questions for the user. In a step-by-step walkthrough, use it to state what the user should confirm for the current fragment; put pane-specific explanations in annotations.',
    ),
  rationale: z
    .string()
    .min(1)
    .max(40_000)
    .describe(
      'Required explanation of why this fragment is being presented and what change the user is being asked to review. Keep confirmation criteria in instructions and pane-specific explanations in annotations.',
    ),
  annotations: z
    .array(DIFF_REVIEW_ANNOTATION_SCHEMA)
    .max(40)
    .optional()
    .describe(
      'Optional pane-specific explanation cards shown with the selected diff or conflict pane. Use before/after/both panes with mode="pr" and base/ours/theirs/resolution panes with mode="merge-conflict"; omit when no pane-specific notes are needed. Do not place these explanations in source panes.',
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
};

export const LIST_SESSIONS_SCHEMA = {
  statusFilter: z
    .enum(['active', 'dormant', 'closed', 'all'])
    .default('active')
    .describe('Filter sessions by lifecycle. Defaults to active and, for real session callers, only returns caller-related sessions. Use "all" when recovering old teammates or checking whether a session was closed.'),
  adapterFilter: z
    .enum(['claude-code', 'codex-cli', 'grok-build'])
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
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .describe('Session id to inspect. Use list_sessions to discover ids before calling when unsure.'),
};

export const LIST_SESSION_EVENTS_SCHEMA = {
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Session id whose normalized Agent Deck event trajectory should be read. The caller may use its current committed handoff ownership chain and may otherwise read only spawn ancestors/descendants or sessions sharing an active team.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('Maximum events to return. Default 100, max 500.'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(0)
    .describe('Number of newest events to skip before returning results. Default 0.'),
};

export const SHUTDOWN_SESSION_SCHEMA = {
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .describe('Target session id to close. The caller cannot shut down itself.'),
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
export type ListSessionEventsArgs = z.infer<z.ZodObject<typeof LIST_SESSION_EVENTS_SCHEMA>>;
export type ShutdownSessionArgs = z.infer<z.ZodObject<typeof SHUTDOWN_SESSION_SCHEMA>>;

/** Runtime-published metadata projection shared by list_sessions and get_session. */
export const PROJECTED_SESSION_OUTPUT_SCHEMA = z
  .object({
    sessionId: z.string().min(1).describe('Canonical Agent Deck session id.'),
    adapter: z
      .string()
      .min(1)
      .describe(
        'Persisted adapter id. Current sessions use claude-code, codex-cli, or grok-build.',
      ),
    gateway: z
      .string()
      .min(1)
      .nullable()
      .describe('Claude Gateway id; null for Codex/Grok or Claude-native default.'),
    provider: z
      .string()
      .min(1)
      .nullable()
      .describe('Codex Gateway id in the provider field; null for Claude/Grok or Codex native default.'),
    cwd: z.string().min(1).max(4096),
    lifecycle: z.enum(['active', 'dormant', 'closed']),
    title: z.string().nullable(),
    lastEventAt: z.number().int().nonnegative().nullable(),
    teamName: z.string().min(1).nullable(),
    teams: z
      .array(
        z
          .object({
            teamId: z.string().min(1),
            teamName: z.string().min(1),
          })
          .strict(),
      )
      .describe('All active team memberships visible on this session.'),
    spawnedBy: z.string().min(1).nullable(),
    spawnDepth: z.number().int().nonnegative(),
  })
  .strict();

export type ProjectedSession = z.infer<typeof PROJECTED_SESSION_OUTPUT_SCHEMA>;

/** list_sessions ok return shape（list.ts handler）。 */
export const LIST_SESSIONS_OUTPUT_SCHEMA = z
  .object({
    total: z.number().int().nonnegative(),
    hasMore: z
      .boolean()
      .describe('True when another page may be available with offset + limit.'),
    sessions: z.array(PROJECTED_SESSION_OUTPUT_SCHEMA),
  })
  .strict();

export type ListSessionsResult = z.infer<typeof LIST_SESSIONS_OUTPUT_SCHEMA>;

/** get_session ok return shape（get.ts handler）。 */
export const GET_SESSION_OUTPUT_SCHEMA = PROJECTED_SESSION_OUTPUT_SCHEMA;
export type GetSessionResult = ProjectedSession;

/** list_session_events ok return shape（list-session-events.ts handler）。 */
export const LIST_SESSION_EVENTS_OUTPUT_SCHEMA = z
  .object({
    sessionId: z.string(),
    hasMore: z.boolean(),
    events: z.array(
      z
        .object({
          id: z.number().int().positive(),
          sessionId: z.string(),
          agentId: z.string(),
          kind: z.string(),
          payload: z.unknown(),
          ts: z.number().int().nonnegative(),
          source: z.enum(['sdk', 'hook']).optional(),
          hookOrigin: z.enum(['sdk', 'cli']).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export interface ListSessionEventsResult {
  sessionId: string;
  /** True when another page may be available with offset + limit. */
  hasMore: boolean;
  events: Array<AgentEvent & { id: number }>;
}

/** send_message ok return shape（send.ts handler；queued: true 字面常量约束）。 */
export const SEND_MESSAGE_OUTPUT_SCHEMA = z
  .object({
    sessionId: z.string(),
    teamId: z.string().nullable(),
    messageId: z.string(),
    replyToMessageId: z.string().nullable(),
    sentAt: z.number().int().nonnegative(),
    queued: z.literal(true),
  })
  .strict();
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

export const REQUEST_PLAN_REVIEW_OUTPUT_SCHEMA = z
  .object({
    decision: z.enum(['approved', 'revise', 'timeout']),
    feedback: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.feedback !== undefined && value.decision !== 'revise') {
      ctx.addIssue({
        code: 'custom',
        path: ['feedback'],
        message: 'feedback is valid only when decision is revise',
      });
    }
  });

export type RequestDiffReviewResult =
  | { decision: 'approved' }
  | { decision: 'revise'; feedback?: string }
  | { decision: 'timeout' };

export const REQUEST_DIFF_REVIEW_OUTPUT_SCHEMA = REQUEST_PLAN_REVIEW_OUTPUT_SCHEMA;

/** shutdown_session ok return shape（shutdown.ts handler；lifecycle: 'closed' 字面常量约束）。 */
export const SHUTDOWN_SESSION_OUTPUT_SCHEMA = z
  .object({
    sessionId: z.string(),
    lifecycle: z.literal('closed'),
    alreadyClosed: z.boolean(),
  })
  .strict();
export interface ShutdownSessionResult {
  sessionId: string;
  lifecycle: 'closed';
  alreadyClosed: boolean;
}
