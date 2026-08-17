import { z } from 'zod';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import {
  firstUnsupportedTargetRuntimeField,
  unsupportedTargetRuntimeFieldMessage,
} from '@main/adapters/runtime-control-contracts';
import { MCP_TARGET_RUNTIME_SUPERSET_SHAPE } from './target-runtime';

// =============== HAND_OFF_SESSION (session baton) ===============

// hand_off_session starts a fresh successor SDK session with a provider-neutral Continuation
// Context (会话续接上下文), commits one durable logical-ownership move, and closes the caller only
// after mandatory transfer succeeds. Tasks, active teams, the active worktree lease, and in-flight
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
      'Optional adapter for the fresh successor. Omit it to inherit the caller adapter. Supported values: claude-code, codex-cli, and grok-build. Select a Claude Gateway with gateway or a Codex Gateway with the public field named provider.',
    ),
  ...MCP_TARGET_RUNTIME_SUPERSET_SHAPE,
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
};

export const EXIT_WORKTREE_SCHEMA = {
  worktreePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => p.startsWith('/'), 'Must be absolute path')
    .optional()
    .describe(
      'Optional absolute worktree path to exit. Omit it to use the caller session structured lease. An override must match that lease exactly; a path without an active caller-owned lease is rejected. Branch names are not part of worktree identity, so renaming or switching a branch does not block exit. State waiting-tool-result means restoration was accepted, not that cleanup finished.',
    ),
  discardChanges: z
    .boolean()
    .optional()
    .describe(
      'Optional boolean, default false. With false, the tool checks tracked and untracked dirty state before acceptance and again immediately before removal, refusing when either check finds changes. Set true only after the user explicitly authorizes permanent deletion of those uncommitted files; it enables forced worktree removal but does not bypass lease/path/repository/reference checks or the durable-HEAD check. The tool never creates, renames, switches, or deletes Git branches or other refs.',
    ),
};

export const HAND_OFF_SESSION_ARGS_SCHEMA = z
  .object(HAND_OFF_SESSION_SHAPE)
  .strict()
  .superRefine((args, ctx) => {
    if (!args.adapter) return;
    const unsupported = firstUnsupportedTargetRuntimeField(args.adapter, args);
    if (!unsupported) return;
    ctx.addIssue({
      code: 'custom',
      path: [unsupported],
      message: unsupportedTargetRuntimeFieldMessage(args.adapter, unsupported),
    });
  });

export type HandOffSessionArgs = z.infer<typeof HAND_OFF_SESSION_ARGS_SCHEMA>;
export type EnterWorktreeArgs = z.infer<z.ZodObject<typeof ENTER_WORKTREE_SCHEMA>>;
export type ExitWorktreeArgs = z.infer<z.ZodObject<typeof EXIT_WORKTREE_SCHEMA>>;

/** Compact hand_off_session result. Provider prompt, spool ids, and runtime fingerprints are
 * intentionally absent; callers receive only safe preparation/transfer observability. */
export interface HandOffSessionResult {
  sessionId: string;
  adapter: 'claude-code' | 'codex-cli' | 'grok-build';
  /** Resolved Claude Gateway profile; null for Codex/Grok or Claude-native default. */
  gateway: string | null;
  /** Resolved Codex Gateway id; null for Claude/Grok or Codex native default. */
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
    usedLowerBudgetRetry: boolean;
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
    worktreeLease: {
      status: 'ok' | 'skipped' | 'failed';
      worktreePath: string | null;
      error?: string;
    };
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
      .literal('detached')
      .describe('Creation mode. enter_worktree always creates a detached HEAD and never mutates a branch or ref.'),
  })
  .strict();

export type EnterWorktreeResult = z.infer<
  typeof ENTER_WORKTREE_OUTPUT_SCHEMA
>;

/**
 * MCP SDK output schemas must normalize to one object schema. Cross-field checks retain the
 * discriminated result contract without publishing a top-level Zod union that the SDK cannot
 * validate or expose through tools/list.
 */
export const EXIT_WORKTREE_OUTPUT_SCHEMA = z
  .object({
    transitionId: z
      .string()
      .min(1)
      .describe('Durable session:generation identity for the accepted or completed exit transition.'),
    direction: z
      .literal('exit')
      .describe('Confirms that this result belongs to exit_worktree.'),
    state: z
      .enum(['waiting-tool-result', 'completed-cleanup'])
      .describe('waiting-tool-result means restoration is durably accepted; completed-cleanup means a cleanup_pending retry finished after restoration.'),
    effectiveFrom: z
      .enum(['automatic-next-turn', 'already-effective'])
      .describe('Must be automatic-next-turn for waiting-tool-result and already-effective for completed-cleanup.'),
    worktreePath: z
      .string()
      .min(1)
      .describe('Absolute owned worktree path scheduled for removal or checked by the cleanup retry.'),
    worktreeRemoved: z
      .boolean()
      .optional()
      .describe('Required only for completed-cleanup: true when removed, false when already absent.'),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.state === 'waiting-tool-result') {
      if (result.effectiveFrom !== 'automatic-next-turn') {
        ctx.addIssue({
          code: 'custom',
          path: ['effectiveFrom'],
          message: 'waiting-tool-result requires effectiveFrom=automatic-next-turn',
        });
      }
      if (result.worktreeRemoved !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['worktreeRemoved'],
          message: 'waiting-tool-result must omit worktreeRemoved',
        });
      }
      return;
    }

    if (result.effectiveFrom !== 'already-effective') {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveFrom'],
        message: 'completed-cleanup requires effectiveFrom=already-effective',
      });
    }
    if (result.worktreeRemoved === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['worktreeRemoved'],
        message: 'completed-cleanup requires worktreeRemoved',
      });
    }
  });

type ExitWorktreeOutput = z.infer<typeof EXIT_WORKTREE_OUTPUT_SCHEMA>;
type ExitWorktreeResultBase = Omit<
  ExitWorktreeOutput,
  'state' | 'effectiveFrom' | 'worktreeRemoved'
>;

export type ExitWorktreeResult = ExitWorktreeResultBase &
  (
    | {
        state: 'waiting-tool-result';
        effectiveFrom: 'automatic-next-turn';
        worktreeRemoved?: never;
      }
    | {
        state: 'completed-cleanup';
        effectiveFrom: 'already-effective';
        worktreeRemoved: boolean;
      }
  );
