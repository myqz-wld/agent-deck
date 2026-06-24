import { z } from 'zod';
import { SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';
import type { SpawnSessionResult } from './spawn';

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
