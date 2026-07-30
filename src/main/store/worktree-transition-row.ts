import type Database from 'better-sqlite3';
import type {
  WorktreeTransitionDirection,
  WorktreeTransitionPhase,
  WorktreeTransitionRecord,
} from '@main/session/worktree-transition/types';

export interface WorktreeTransitionRow {
  session_id: string;
  format_version: number;
  generation: number;
  direction: WorktreeTransitionDirection;
  phase: WorktreeTransitionPhase;
  original_cwd: string;
  target_cwd: string;
  main_repo: string;
  worktree_path: string;
  work_branch: string;
  base_branch: string;
  base_commit: string;
  tool_use_id: string | null;
  continuation_key: string;
  continuation_delivered: number;
  discard_changes: number;
  delete_branch: number;
  requested_at: number;
  updated_at: number;
  last_error: string | null;
}

export class WorktreeTransitionConflictError extends Error {
  readonly code = 'WORKTREE_TRANSITION_CONFLICT';

  constructor(
    readonly sessionId: string,
    readonly generation: number | null,
    readonly phase: WorktreeTransitionPhase | null,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeTransitionConflictError';
  }
}

export function rowToWorktreeTransition(
  row: WorktreeTransitionRow,
): WorktreeTransitionRecord {
  return {
    sessionId: row.session_id,
    formatVersion: 1,
    generation: row.generation,
    direction: row.direction,
    phase: row.phase,
    originalCwd: row.original_cwd,
    targetCwd: row.target_cwd,
    mainRepo: row.main_repo,
    worktreePath: row.worktree_path,
    workBranch: row.work_branch,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    toolUseId: row.tool_use_id,
    continuationKey: row.continuation_key,
    continuationDelivered: row.continuation_delivered === 1,
    discardChanges: row.discard_changes === 1,
    deleteBranch: row.delete_branch === 1,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

export function getWorktreeTransitionWithDb(
  db: Database.Database,
  sessionId: string,
): WorktreeTransitionRecord | null {
  const row = db
    .prepare(`SELECT * FROM worktree_cwd_transitions WHERE session_id = ?`)
    .get(sessionId) as WorktreeTransitionRow | undefined;
  return row ? rowToWorktreeTransition(row) : null;
}

export function requireWorktreeTransitionGeneration(
  db: Database.Database,
  sessionId: string,
  generation: number,
): WorktreeTransitionRecord {
  const current = getWorktreeTransitionWithDb(db, sessionId);
  if (!current || current.generation !== generation) {
    throw new WorktreeTransitionConflictError(
      sessionId,
      current?.generation ?? null,
      current?.phase ?? null,
      `Worktree cwd transition ${sessionId}:${generation} is stale or missing.`,
    );
  }
  return current;
}
