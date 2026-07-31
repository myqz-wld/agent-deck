import type Database from 'better-sqlite3';
import type {
  LegacyWorktreeExitAdoption,
  WorktreeTransitionRecord,
  WorktreeTransitionPhase,
} from '@main/session/worktree-transition/types';
import { isLegacyExitContinuationKey } from '@main/session/worktree-transition/constants';
import { deleteWorktreeTransitionInputsWithDb } from './worktree-transition-input-repo';
import {
  getWorktreeTransitionWithDb as getWithDb,
  rowToWorktreeTransition as rowToRecord,
  WorktreeTransitionConflictError,
  type WorktreeTransitionRow,
} from './worktree-transition-row';

/**
 * Upgrade a marker-only legacy worktree (or an explicitly named orphan path) directly into an
 * exit preflight. The transaction claims the marker and exact tool invocation together, so no
 * synchronous Git removal can run without durable restore-first cleanup authority.
 */
export function adoptLegacyExitWithDb(
  db: Database.Database,
  input: LegacyWorktreeExitAdoption,
): WorktreeTransitionRecord {
  return db.transaction(() => {
    const current = getWithDb(db, input.sessionId);
    if (current && current.phase !== 'cleared') {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current.generation,
        current.phase,
        `Session ${input.sessionId} already owns worktree transition ` +
          `${current.sessionId}:${current.generation} in phase ${current.phase}.`,
      );
    }

    const session = db
      .prepare(`SELECT cwd_release_marker FROM sessions WHERE id = ?`)
      .get(input.sessionId) as
      | { cwd_release_marker: string | null }
      | undefined;
    if (!session) {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current?.generation ?? null,
        current?.phase ?? null,
        `Cannot adopt legacy worktree exit for missing session ${input.sessionId}.`,
      );
    }
    if ((session.cwd_release_marker ?? null) !== input.expectedMarker) {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current?.generation ?? null,
        current?.phase ?? null,
        `Legacy worktree marker changed during exit preflight for session ${input.sessionId}.`,
      );
    }

    const competingMarker = db
      .prepare(
        `SELECT id FROM sessions
         WHERE id <> ?
           AND cwd_release_marker IS NOT NULL
           AND (cwd_release_marker = ? OR cwd_release_marker = ?)
         LIMIT 1`,
      )
      .get(
        input.sessionId,
        input.worktreePath,
        input.expectedMarker ?? input.worktreePath,
      ) as { id: string } | undefined;
    if (competingMarker) {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current?.generation ?? null,
        current?.phase ?? null,
        `Cannot adopt worktree ${input.worktreePath}; another session marker still owns it.`,
      );
    }

    const competingLease = db
      .prepare(
        `SELECT * FROM worktree_cwd_transitions
         WHERE session_id <> ? AND worktree_path = ? AND phase <> 'cleared'
         LIMIT 1`,
      )
      .get(input.sessionId, input.worktreePath) as
      | WorktreeTransitionRow
      | undefined;
    if (competingLease) {
      const record = rowToRecord(competingLease);
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current?.generation ?? null,
        current?.phase ?? null,
        `Cannot adopt worktree ${input.worktreePath}; transition ` +
          `${record.sessionId}:${record.generation} is ${record.phase}.`,
      );
    }

    const generation = (current?.generation ?? 0) + 1;
    deleteWorktreeTransitionInputsWithDb(db, input.sessionId);
    db.prepare(
      `INSERT INTO worktree_cwd_transitions
        (session_id, format_version, generation, direction, phase, original_cwd, target_cwd,
         main_repo, worktree_path, work_branch, base_branch, base_commit, tool_use_id,
         continuation_key, continuation_delivered, discard_changes, delete_branch,
         requested_at, updated_at, last_error)
       VALUES
        (@session_id, 1, @generation, 'exit', 'exit_preflight', @original_cwd, @original_cwd,
         @main_repo, @worktree_path, @work_branch, @base_branch, @base_commit, @tool_use_id,
         @continuation_key, 0, @discard_changes, @delete_branch,
         @requested_at, @requested_at, NULL)
       ON CONFLICT(session_id) DO UPDATE SET
         format_version = 1,
         generation = excluded.generation,
         direction = excluded.direction,
         phase = excluded.phase,
         original_cwd = excluded.original_cwd,
         target_cwd = excluded.target_cwd,
         main_repo = excluded.main_repo,
         worktree_path = excluded.worktree_path,
         work_branch = excluded.work_branch,
         base_branch = excluded.base_branch,
         base_commit = excluded.base_commit,
         tool_use_id = excluded.tool_use_id,
         continuation_key = excluded.continuation_key,
         continuation_delivered = 0,
         discard_changes = excluded.discard_changes,
         delete_branch = excluded.delete_branch,
         requested_at = excluded.requested_at,
         updated_at = excluded.updated_at,
         last_error = NULL`,
    ).run({
      session_id: input.sessionId,
      generation,
      original_cwd: input.originalCwd,
      main_repo: input.mainRepo,
      worktree_path: input.worktreePath,
      work_branch: input.workBranch,
      base_branch: input.baseBranch,
      base_commit: input.baseCommit,
      tool_use_id: input.toolUseId,
      continuation_key: input.continuationKey,
      discard_changes: input.discardChanges ? 1 : 0,
      delete_branch: input.deleteBranch ? 1 : 0,
      requested_at: input.requestedAt,
    });
    db.prepare(
      `UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`,
    ).run(input.worktreePath, input.sessionId);
    return getWithDb(db, input.sessionId)!;
  })();
}

/**
 * Return an unacknowledged adopted exit to marker-only compatibility state. No cwd, marker, Git
 * state, or user files are changed; a later exit_worktree call can adopt the path again.
 */
export function releaseLegacyExitAdoptionWithDb(
  db: Database.Database,
  input: {
    sessionId: string;
    generation: number;
    expected: Extract<
      WorktreeTransitionPhase,
      'exit_preflight' | 'exit_waiting_tool_result'
    >;
    updatedAt: number;
    lastError: string;
  },
): WorktreeTransitionRecord {
  return db.transaction(() => {
    const current = getWithDb(db, input.sessionId);
    if (
      !current ||
      current.generation !== input.generation ||
      current.phase !== input.expected ||
      !isLegacyExitContinuationKey(current.continuationKey)
    ) {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current?.generation ?? null,
        current?.phase ?? null,
        `Cannot release legacy worktree exit ${input.sessionId}:${input.generation} from ${current?.phase ?? 'missing'}.`,
      );
    }
    const result = db
      .prepare(
        `UPDATE worktree_cwd_transitions
         SET phase = 'cleared',
             target_cwd = original_cwd,
             updated_at = ?,
             last_error = ?
         WHERE session_id = ? AND generation = ? AND phase = ?`,
      )
      .run(
        input.updatedAt,
        input.lastError,
        input.sessionId,
        input.generation,
        input.expected,
      );
    if (result.changes !== 1) {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current.generation,
        current.phase,
        `Failed to release legacy worktree exit ${input.sessionId}:${input.generation}.`,
      );
    }
    return getWithDb(db, input.sessionId)!;
  })();
}
