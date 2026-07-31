import { z } from 'zod';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';
import { MCP_TARGET_RUNTIME_SUPERSET_SHAPE } from './target-runtime';

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
  startPoint: z
    .string()
    .min(1)
    .max(512)
    .regex(/^\S+$/, 'startPoint must not contain whitespace')
    .refine((value) => !value.startsWith('-'), 'startPoint must not start with a hyphen')
    .describe(
      'Required Git commit-ish, 1-512 non-whitespace characters and not beginning with "-". Accepts HEAD, branch/tag/remote-tracking ref names, commit ids, and single-commit revision expressions such as HEAD~1. The tool resolves it once in the caller repository with a 30-second git rev-parse --verify --end-of-options <startPoint>^{commit} check, requires exactly one full 40- or 64-hex object id, freezes it, and never creates, switches, renames, or deletes any branch or ref. Invalid input, resolution failure, or timeout creates no worktree and changes no Git state; retry only after correcting the revision or transient Git failure.',
    ),
  worktreePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute worktree path, maximum 4096 characters. Omit it unless the user or project requires a custom layout. When omitted, the tool derives <effective-worktree-root>/agent-deck-<caller-session-prefix>-<base36-request-time>; the name never depends on a branch. The path must not exist. Preparation recursively creates its parent directory, which may remain empty if a later step fails. Git worktree creation has a 10-minute timeout and is not retried automatically. After the provider observes the accepted result, Agent Deck automatically applies this cwd to the session.',
    ),
  worktreeRoot: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute root, maximum 4096 characters, used only when worktreePath is omitted. Omit both path fields to use <main-repo>/.agent-deck/worktrees after ensuring the main repository .gitignore contains the exact .agent-deck/ entry. This field changes only directory placement and never names or creates a Git ref.',
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
      'Optional absolute worktree path to exit. Omit it to use the caller session structured lease or legacy marker set by enter_worktree. An override must match that owned path exactly. Existing marker-only or explicitly named registered worktrees are adopted into the same restore-first flow. Branch names are not part of worktree identity, so renaming or switching a branch does not block exit. State waiting-tool-result means restoration was accepted, not that cleanup finished; completed-legacy is returned only when the target path is already absent.',
    ),
  discardChanges: z
    .boolean()
    .optional()
    .describe(
      'Optional boolean, default false. With false, the tool checks tracked and untracked dirty state before acceptance and again immediately before removal, refusing when either check finds changes. Set true only after the user explicitly authorizes permanent deletion of those uncommitted files; it enables forced worktree removal but does not bypass lease/path/repository/reference checks or the durable-HEAD check. The tool never creates, renames, switches, or deletes Git branches or other refs.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

export const HAND_OFF_SESSION_ARGS_SCHEMA = z.object(HAND_OFF_SESSION_SHAPE).strict();

export type HandOffSessionArgs = z.infer<typeof HAND_OFF_SESSION_ARGS_SCHEMA>;
export type EnterWorktreeArgs = z.infer<z.ZodObject<typeof ENTER_WORKTREE_SCHEMA>>;
export type ExitWorktreeArgs = z.infer<z.ZodObject<typeof EXIT_WORKTREE_SCHEMA>>;

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
    transitionId: z
      .string()
      .min(1)
      .describe('Durable session:generation identity for the accepted enter transition.'),
    direction: z
      .literal('enter')
      .describe('Confirms that this result belongs to enter_worktree.'),
    state: z
      .literal('waiting-tool-result')
      .describe('Detached worktree creation is durably accepted but the caller still runs in its old cwd.'),
    effectiveFrom: z
      .literal('automatic-next-turn')
      .describe('The provider must observe this exact result before Agent Deck ends the old turn and switches cwd.'),
    worktreePath: z
      .string()
      .min(1)
      .describe('Absolute newly created detached worktree path that will become the session cwd.'),
    startCommit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
      .describe('Frozen 40- or 64-hex Git commit object id resolved from startPoint before creation.'),
    headMode: z
      .enum(['detached', 'legacy-attached'])
      .describe('Creation mode. New calls always return "detached". "legacy-attached" appears only when idempotently reporting a pre-upgrade transition that had already created a branch-attached worktree; the retry does not mutate that branch or ref.'),
    markerSet: z
      .boolean()
      .describe('True after the durable cwd-release marker is stored; false only for an idempotent response while initial creation is still settling.'),
  })
  .strict();

export type EnterWorktreeResult = z.infer<
  typeof ENTER_WORKTREE_OUTPUT_SCHEMA
>;

const EXIT_WORKTREE_WAITING_OUTPUT_SCHEMA = z
  .object({
    transitionId: z
      .string()
      .min(1)
      .describe('Durable session:generation identity for the accepted exit transition.'),
    direction: z
      .literal('exit')
      .describe('Confirms that this result belongs to exit_worktree.'),
    state: z
      .literal('waiting-tool-result')
      .describe('The restore-first transition is durably accepted but has not completed cleanup yet.'),
    effectiveFrom: z
      .literal('automatic-next-turn')
      .describe('The provider must observe this exact result before Agent Deck ends the old turn and restores cwd.'),
    worktreePath: z
      .string()
      .min(1)
      .describe('Absolute owned worktree path scheduled for removal after cwd restoration.'),
  })
  .strict();

const EXIT_WORKTREE_COMPLETED_OUTPUT_SCHEMA = z
  .object({
    transitionId: z
      .string()
      .min(1)
      .describe('Durable session:generation identity of the completed exit transition.'),
    direction: z
      .literal('exit')
      .describe('Confirms that this result belongs to exit_worktree.'),
    state: z
      .literal('completed-cleanup')
      .describe('A cleanup_pending retry completed after cwd had already been restored.'),
    effectiveFrom: z
      .literal('already-effective')
      .describe('The caller session was already running from its original cwd before this retry returned.'),
    worktreePath: z
      .string()
      .min(1)
      .describe('Absolute owned worktree path checked by this cleanup retry.'),
    worktreeRemoved: z
      .boolean()
      .describe('True when this retry removed the worktree; false when it was already absent.'),
    markerCleared: z
      .literal(true)
      .describe('Confirms that the caller no longer owns a worktree cleanup marker.'),
  })
  .strict();

const EXIT_WORKTREE_LEGACY_OUTPUT_SCHEMA = z
  .object({
    transitionId: z
      .null()
      .describe('Null because no asynchronous transition was needed for an already-absent target.'),
    direction: z
      .literal('exit')
      .describe('Confirms that this result belongs to exit_worktree.'),
    state: z
      .literal('completed-legacy')
      .describe('The requested legacy target was already absent, so no worktree removal ran.'),
    effectiveFrom: z
      .literal('already-effective')
      .describe('No provider turn boundary or cwd transition remains pending.'),
    worktreePath: z
      .string()
      .min(1)
      .describe('Absolute target path that was already absent.'),
    worktreeRemoved: z
      .literal(false)
      .describe('Always false because the target did not exist when this call ran.'),
    markerCleared: z
      .boolean()
      .describe('True when a stale caller marker was cleared; false when no marker existed or clearing failed.'),
  })
  .strict();

/** exit_worktree success is accepted restoration, completed cleanup, or an already-absent target. */
export const EXIT_WORKTREE_OUTPUT_SCHEMA = z.discriminatedUnion('state', [
  EXIT_WORKTREE_WAITING_OUTPUT_SCHEMA,
  EXIT_WORKTREE_COMPLETED_OUTPUT_SCHEMA,
  EXIT_WORKTREE_LEGACY_OUTPUT_SCHEMA,
]);

export type ExitWorktreeResult = z.infer<
  typeof EXIT_WORKTREE_OUTPUT_SCHEMA
>;
