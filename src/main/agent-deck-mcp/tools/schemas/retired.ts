import { z } from 'zod';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';
import { MCP_TARGET_RUNTIME_SUPERSET_SHAPE } from './target-runtime';

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

// hand_off_session starts a fresh successor SDK session with a provider-neutral Continuation
// Context (会话续接上下文), commits one durable logical-ownership move, and closes the caller only
// after mandatory transfer succeeds. Tasks, active teams, the worktree marker, and in-flight
// message endpoints move directly; only the latest successor retains issue authority, while
// pending plan gates and related trajectory visibility follow the handoff chain and historical
// provenance remains unchanged. Only the
// explicit current instruction is persisted as the first user message; checkpoint/history evidence
// is delivered through the private trusted turn.
export const HAND_OFF_SESSION_SHAPE = {
  prompt: z
    .string()
    .min(1)
    .max(MAX_USER_MESSAGE_LENGTH)
    .describe(
      'Authoritative current instruction for the fresh successor. Include the concrete next action and any durable plan or temporary context file paths it must read. Agent Deck prepares a bounded Continuation Context (会话续接上下文) from validated checkpoints and retained user inputs, sends that evidence only through the private provider turn, and persists only this instruction. Historical evidence cannot override current system/project instructions. For unusually large artifacts, write them under /tmp and reference the absolute path here.',
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
    .enum(['claude-code', 'codex-cli', 'grok-build'])
    .optional()
    .describe(
      'Optional adapter for the fresh successor. Omit it to inherit the caller adapter. Supported values: claude-code, codex-cli, and grok-build. Deepseek is selected with adapter="claude-code" and provider="deepseek".',
    ),
  ...MCP_TARGET_RUNTIME_SUPERSET_SHAPE,
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

// enter_worktree / exit_worktree provide one asynchronous, provider-observed cwd transition
// contract. Their success result acknowledges durable preparation; the effective cwd changes only
// after the exact tool result reaches the provider and Agent Deck completes the expected turn
// boundary.
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
      'Optional new branch name for the worktree. Omit it to let Agent Deck derive a unique branch name from the caller session and baseBranch. The branch must not already exist. Creation is durable preparation for an automatic cwd transition; success does not mean the current provider turn already runs there.',
    ),
  worktreePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute worktree path. Omit it unless the user or project explicitly requires a custom layout. When both worktreePath and worktreeRoot are omitted, the default is <main-repo>/.agent-deck/worktrees/<derived-branch-slug>. The path must not already exist. Agent Deck applies this path to the session automatically after the provider observes the successful tool result.',
    ),
  worktreeRoot: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute root used to derive worktreePath when worktreePath is omitted. Omit it unless the user or project explicitly requires a custom layout. Omit both path fields to use <main-repo>/.agent-deck/worktrees, after ensuring the main repository .gitignore contains the exact .agent-deck/ entry.',
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
      'Optional absolute worktree path to exit. Omit it to use the caller session structured lease or legacy marker set by enter_worktree. Passing a different path while the caller owns a lease or marker is rejected. For a structured lease, success state waiting-tool-result means automatic restoration was accepted, not that cleanup already finished.',
    ),
  discardChanges: z
    .boolean()
    .optional()
    .describe(
      'Default false. The tool performs a preflight dirty check and a second dirty check immediately before removal. It refuses removal when either check finds changes unless this is true. Pass true only when the user explicitly authorizes abandoning uncommitted changes.',
    ),
  deleteBranch: z
    .boolean()
    .optional()
    .describe(
      'Default false. Automatic exit restores and confirms the original runtime/database cwd before removing the worktree, and keeps the work branch by default. Never set true automatically: immediately before every use, ask the user whether to delete the branch and receive explicit approval. Generic finish or cleanup instructions and pushed, merged, cherry-picked, or abandoned branch state are not approval. Unmerged branch deletion is rejected unless discardChanges=true.',
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

export const ARCHIVE_PLAN_ARGS_SCHEMA = z.object(ARCHIVE_PLAN_SHAPE).strict();
export const HAND_OFF_SESSION_ARGS_SCHEMA = z.object(HAND_OFF_SESSION_SHAPE).strict();

export type ArchivePlanArgs = z.infer<typeof ARCHIVE_PLAN_ARGS_SCHEMA>;
export type HandOffSessionArgs = z.infer<typeof HAND_OFF_SESSION_ARGS_SCHEMA>;
export type EnterWorktreeArgs = z.infer<z.ZodObject<typeof ENTER_WORKTREE_SCHEMA>>;
export type ExitWorktreeArgs = z.infer<z.ZodObject<typeof EXIT_WORKTREE_SCHEMA>>;
export type ShutdownBatonTeammatesArgs = z.infer<
  z.ZodObject<typeof SHUTDOWN_BATON_TEAMMATES_SCHEMA>
>;

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

/** Compact hand_off_session result. Provider prompt, spool ids, and runtime fingerprints are
 * intentionally absent; callers receive only safe preparation/transfer observability. */
export interface HandOffSessionResult {
  sessionId: string;
  adapter: 'claude-code' | 'codex-cli' | 'grok-build';
  /** Resolved Claude Gateway profile or Codex model_provider; null means provider-native default. */
  provider: string | null;
  cwd: string;
  continuationContext: {
    version: number;
    quality: 'full' | 'projected' | 'coverage-gap' | 'raw-only' | 'instruction-only';
    sourceEventRevision: number;
    cutoverEventRevision: number;
    rebuildAfterRevision: number;
    checkpoint: {
      id: number | null;
      formatVersion: number;
      throughRevision: number;
      refreshed: boolean;
    };
    preparationHash: string;
    tokenStats: {
      rawRetentionCeiling: number;
      targetPromptCapacity: number;
      checkpointProjectionBudget: number;
      generatorFoldInputBudget: number;
      estimatedPrompt: number;
      checkpoint: number;
      rawTail: number;
    };
    includedUserMessages: number;
    lateMessagesDelivered: number;
    truncatedBoundaryMessages: number;
    foldCalls: number;
    repairCalls: number;
    warningCodes: string[];
  };
  /** Source close result after successful creation and mandatory resource transfer. */
  callerClosed: 'ok' | 'failed';
  /** Non-fatal source advancement/finalization warnings never invalidate the successor. */
  warnings: Array<'source-finalization-failed' | 'source-advanced-after-capture'>;
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

/** enter_worktree published asynchronous success contract. Errors use the ordinary MCP error body. */
export const ENTER_WORKTREE_OUTPUT_SCHEMA = z
  .object({
    transitionId: z.string().min(1),
    direction: z.literal('enter'),
    state: z.literal('waiting-tool-result'),
    effectiveFrom: z.literal('automatic-next-turn'),
    worktreePath: z.string().min(1),
    workBranch: z.string().min(1),
    baseBranch: z.string().min(1),
    baseCommit: z.string().min(1),
    baseSource: z.literal('base-branch'),
    markerSet: z.boolean(),
  })
  .strict();

export type EnterWorktreeResult = z.infer<
  typeof ENTER_WORKTREE_OUTPUT_SCHEMA
>;

const EXIT_WORKTREE_WAITING_OUTPUT_SCHEMA = z
  .object({
    transitionId: z.string().min(1),
    direction: z.literal('exit'),
    state: z.literal('waiting-tool-result'),
    effectiveFrom: z.literal('automatic-next-turn'),
    worktreePath: z.string().min(1),
    workBranch: z.string().min(1),
  })
  .strict();

const EXIT_WORKTREE_COMPLETED_OUTPUT_SCHEMA = z
  .object({
    transitionId: z.string().min(1),
    direction: z.literal('exit'),
    state: z.literal('completed-cleanup'),
    effectiveFrom: z.literal('already-effective'),
    worktreePath: z.string().min(1),
    workBranch: z.string().nullable(),
    branchDeleted: z.boolean(),
    worktreeRemoved: z.boolean(),
    markerCleared: z.literal(true),
  })
  .strict();

const EXIT_WORKTREE_LEGACY_OUTPUT_SCHEMA = z
  .object({
    transitionId: z.null(),
    direction: z.literal('exit'),
    state: z.literal('completed-legacy'),
    effectiveFrom: z.literal('already-effective'),
    worktreePath: z.string().min(1),
    workBranch: z.string().nullable(),
    branchDeleted: z.boolean(),
    worktreeRemoved: z.boolean(),
    markerCleared: z.boolean(),
  })
  .strict();

/** exit_worktree success is either accepted async restoration or completed cleanup/legacy work. */
export const EXIT_WORKTREE_OUTPUT_SCHEMA = z.discriminatedUnion('state', [
  EXIT_WORKTREE_WAITING_OUTPUT_SCHEMA,
  EXIT_WORKTREE_COMPLETED_OUTPUT_SCHEMA,
  EXIT_WORKTREE_LEGACY_OUTPUT_SCHEMA,
]);

export type ExitWorktreeResult = z.infer<
  typeof EXIT_WORKTREE_OUTPUT_SCHEMA
>;

/** Retired shutdown_baton_teammates ok return shape kept for legacy handlers. */
export interface ShutdownBatonTeammatesResult {
  closed: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  skipped: null;
  planId: string | null;
}
