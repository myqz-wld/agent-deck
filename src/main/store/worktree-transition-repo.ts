import type Database from 'better-sqlite3';
import { getDb } from './db';
import {
  assertDirectionMatchesPhase,
  assertWorktreeTransitionStep,
} from '@main/session/worktree-transition/state-machine';
import type {
  NewWorktreeTransition,
  WorktreeExitOptions,
  WorktreeTransitionDirection,
  WorktreeTransitionPhase,
  WorktreeTransitionRecord,
} from '@main/session/worktree-transition/types';
import {
  deleteWorktreeTransitionInputsWithDb,
  renameWorktreeTransitionInputsWithDb,
} from './worktree-transition-input-repo';
import {
  getWorktreeTransitionWithDb as getWithDb,
  requireWorktreeTransitionGeneration as requireGeneration,
  rowToWorktreeTransition as rowToRecord,
  WorktreeTransitionConflictError,
  type WorktreeTransitionRow,
} from './worktree-transition-row';

export { WorktreeTransitionConflictError } from './worktree-transition-row';

export function createEnterWithDb(
  db: Database.Database,
  input: NewWorktreeTransition,
): WorktreeTransitionRecord {
  return db.transaction(() => {
    const current = getWithDb(db, input.sessionId);
    if (current && current.phase !== 'cleared') {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current.generation,
        current.phase,
        `Session ${input.sessionId} already owns worktree transition ${current.sessionId}:${current.generation} in phase ${current.phase}.`,
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
        (@session_id, 1, @generation, 'enter', 'creating', @original_cwd, @target_cwd,
         @main_repo, @worktree_path, @work_branch, @base_branch, @base_commit, @tool_use_id,
         @continuation_key, 0, 0, 0, @requested_at, @requested_at, NULL)
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
         discard_changes = 0,
         delete_branch = 0,
         requested_at = excluded.requested_at,
         updated_at = excluded.updated_at,
         last_error = NULL`,
    ).run({
      session_id: input.sessionId,
      generation,
      original_cwd: input.originalCwd,
      target_cwd: input.targetCwd,
      main_repo: input.mainRepo,
      worktree_path: input.worktreePath,
      work_branch: input.workBranch,
      base_branch: input.baseBranch,
      base_commit: input.baseCommit,
      tool_use_id: input.toolUseId,
      continuation_key: input.continuationKey,
      requested_at: input.requestedAt,
    });
    return getWithDb(db, input.sessionId)!;
  })();
}

export function markEnterCreatedWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
  updatedAt: number,
): WorktreeTransitionRecord {
  return db.transaction(() => {
    const current = requireGeneration(db, sessionId, generation);
    assertWorktreeTransitionStep(current.phase, 'enter_waiting_tool_result');
    const result = db
      .prepare(
        `UPDATE worktree_cwd_transitions
         SET phase = 'enter_waiting_tool_result', updated_at = ?, last_error = NULL
         WHERE session_id = ? AND generation = ? AND phase = 'creating'`,
      )
      .run(updatedAt, sessionId, generation);
    if (result.changes !== 1) {
      throw new WorktreeTransitionConflictError(
        sessionId,
        current.generation,
        current.phase,
        `Failed to arm worktree enter ${sessionId}:${generation} from phase ${current.phase}.`,
      );
    }
    db.prepare(`UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`).run(
      current.worktreePath,
      sessionId,
    );
    return getWithDb(db, sessionId)!;
  })();
}

export function beginExitPreflightWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
  options: WorktreeExitOptions,
): WorktreeTransitionRecord {
  return db.transaction(() => {
    const current = requireGeneration(db, sessionId, generation);
    assertWorktreeTransitionStep(current.phase, 'exit_preflight');
    const result = db
      .prepare(
        `UPDATE worktree_cwd_transitions
         SET direction = 'exit',
             phase = 'exit_preflight',
             target_cwd = original_cwd,
             tool_use_id = ?,
             continuation_key = ?,
             continuation_delivered = 0,
             discard_changes = ?,
             delete_branch = ?,
             requested_at = ?,
             updated_at = ?,
             last_error = NULL
         WHERE session_id = ? AND generation = ? AND phase = 'active'`,
      )
      .run(
        options.toolUseId,
        options.continuationKey,
        options.discardChanges ? 1 : 0,
        options.deleteBranch ? 1 : 0,
        options.requestedAt,
        options.requestedAt,
        sessionId,
        generation,
      );
    if (result.changes !== 1) {
      throw new WorktreeTransitionConflictError(
        sessionId,
        current.generation,
        current.phase,
        `Failed to begin worktree exit ${sessionId}:${generation} from phase ${current.phase}.`,
      );
    }
    return getWithDb(db, sessionId)!;
  })();
}

export function compareAndSetPhaseWithDb(
  db: Database.Database,
  input: {
    sessionId: string;
    generation: number;
    expected: WorktreeTransitionPhase;
    next: WorktreeTransitionPhase;
    updatedAt: number;
    lastError?: string | null;
  },
): WorktreeTransitionRecord {
  return db.transaction(() => {
    const current = requireGeneration(db, input.sessionId, input.generation);
    if (current.phase !== input.expected) {
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        current.generation,
        current.phase,
        `Expected worktree transition ${input.sessionId}:${input.generation} in phase ${input.expected}, found ${current.phase}.`,
      );
    }
    assertWorktreeTransitionStep(input.expected, input.next);
    const direction: WorktreeTransitionDirection =
      input.next === 'active' ? 'enter' : current.direction;
    assertDirectionMatchesPhase(direction, input.next);
    const result = db
      .prepare(
        `UPDATE worktree_cwd_transitions
         SET direction = ?,
             phase = ?,
             target_cwd = CASE WHEN ? = 'active' THEN worktree_path ELSE target_cwd END,
             updated_at = ?,
             last_error = ?
         WHERE session_id = ? AND generation = ? AND phase = ?`,
      )
      .run(
        direction,
        input.next,
        input.next,
        input.updatedAt,
        input.lastError ?? null,
        input.sessionId,
        input.generation,
        input.expected,
      );
    if (result.changes !== 1) {
      const latest = getWithDb(db, input.sessionId);
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        latest?.generation ?? null,
        latest?.phase ?? null,
        `Compare-and-set lost for worktree transition ${input.sessionId}:${input.generation}.`,
      );
    }
    if (input.next === 'cleared') {
      db.prepare(`UPDATE sessions SET cwd_release_marker = NULL WHERE id = ?`).run(
        input.sessionId,
      );
    }
    return getWithDb(db, input.sessionId)!;
  })();
}

export function markContinuationDeliveredWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
  continuationKey: string,
  updatedAt: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE worktree_cwd_transitions
       SET continuation_delivered = 1, updated_at = ?
       WHERE session_id = ? AND generation = ? AND continuation_key = ?
         AND continuation_delivered = 0`,
    )
    .run(updatedAt, sessionId, generation, continuationKey);
  return result.changes === 1;
}

export function transferActiveLeaseWithDb(
  db: Database.Database,
  sourceSessionId: string,
  targetSessionId: string,
  updatedAt: number,
): WorktreeTransitionRecord | null {
  return db.transaction(() => {
    const current = getWithDb(db, sourceSessionId);
    if (!current || current.phase === 'cleared') return null;
    if (current.phase !== 'active') {
      throw new WorktreeTransitionConflictError(
        sourceSessionId,
        current.generation,
        current.phase,
        `Cannot transfer pending worktree transition ${sourceSessionId}:${current.generation}; retry after it settles.`,
      );
    }
    if (getWithDb(db, targetSessionId)) {
      throw new WorktreeTransitionConflictError(
        targetSessionId,
        null,
        null,
        `Target session ${targetSessionId} already has worktree transition state.`,
      );
    }
    db.prepare(
      `UPDATE worktree_cwd_transitions SET session_id = ?, updated_at = ?
       WHERE session_id = ? AND generation = ? AND phase = 'active'`,
    ).run(targetSessionId, updatedAt, sourceSessionId, current.generation);
    renameWorktreeTransitionInputsWithDb(
      db,
      sourceSessionId,
      targetSessionId,
    );
    db.prepare(
      `UPDATE sessions SET cwd = ?, cwd_release_marker = ? WHERE id = ?`,
    ).run(current.worktreePath, current.worktreePath, targetSessionId);
    db.prepare(
      `UPDATE sessions SET cwd = ?, cwd_release_marker = NULL WHERE id = ?`,
    ).run(current.originalCwd, sourceSessionId);
    return getWithDb(db, targetSessionId)!;
  })();
}

export function renameLeaseWithDb(
  db: Database.Database,
  fromSessionId: string,
  toSessionId: string,
  updatedAt: number,
): void {
  if (fromSessionId === toSessionId) return;
  db.transaction(() => {
    const source = getWithDb(db, fromSessionId);
    if (!source) return;
    const target = getWithDb(db, toSessionId);
    if (target && target.phase !== 'cleared') {
      throw new WorktreeTransitionConflictError(
        toSessionId,
        target.generation,
        target.phase,
        `Cannot rename worktree transition onto active target ${toSessionId}:${target.generation}.`,
      );
    }
    if (target) {
      deleteWorktreeTransitionInputsWithDb(db, toSessionId);
      db.prepare(`DELETE FROM worktree_cwd_transitions WHERE session_id = ?`).run(
        toSessionId,
      );
    }
    db.prepare(
      `UPDATE worktree_cwd_transitions SET session_id = ?, updated_at = ?
       WHERE session_id = ?`,
    ).run(toSessionId, updatedAt, fromSessionId);
    renameWorktreeTransitionInputsWithDb(db, fromSessionId, toSessionId);
  })();
}

export function setLastErrorWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
  error: string,
  updatedAt: number,
): WorktreeTransitionRecord {
  const result = db
    .prepare(
      `UPDATE worktree_cwd_transitions SET last_error = ?, updated_at = ?
       WHERE session_id = ? AND generation = ?`,
    )
    .run(error, updatedAt, sessionId, generation);
  if (result.changes !== 1) requireGeneration(db, sessionId, generation);
  return getWithDb(db, sessionId)!;
}

export function getWorktreeTransition(
  sessionId: string,
): WorktreeTransitionRecord | null {
  return getWithDb(getDb(), sessionId);
}

export function listRecoverableWorktreeTransitions(): WorktreeTransitionRecord[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM worktree_cwd_transitions
         WHERE phase <> 'cleared'
         ORDER BY requested_at ASC, session_id ASC`,
      )
      .all() as WorktreeTransitionRow[]
  ).map(rowToRecord);
}

export function listWorktreePathReferences(
  worktreePath: string,
): WorktreeTransitionRecord[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM worktree_cwd_transitions
         WHERE worktree_path = ? AND phase <> 'cleared'
         ORDER BY session_id ASC`,
      )
      .all(worktreePath) as WorktreeTransitionRow[]
  ).map(rowToRecord);
}

export const worktreeTransitionRepo = {
  get: getWorktreeTransition,
  listRecoverable: listRecoverableWorktreeTransitions,
  listPathReferences: listWorktreePathReferences,
  createEnter(input: NewWorktreeTransition) {
    return createEnterWithDb(getDb(), input);
  },
  markEnterCreated(sessionId: string, generation: number, updatedAt: number) {
    return markEnterCreatedWithDb(getDb(), sessionId, generation, updatedAt);
  },
  beginExitPreflight(
    sessionId: string,
    generation: number,
    options: WorktreeExitOptions,
  ) {
    return beginExitPreflightWithDb(
      getDb(),
      sessionId,
      generation,
      options,
    );
  },
  compareAndSetPhase(input: Parameters<typeof compareAndSetPhaseWithDb>[1]) {
    return compareAndSetPhaseWithDb(getDb(), input);
  },
  markContinuationDelivered(
    sessionId: string,
    generation: number,
    continuationKey: string,
    updatedAt: number,
  ) {
    return markContinuationDeliveredWithDb(
      getDb(),
      sessionId,
      generation,
      continuationKey,
      updatedAt,
    );
  },
  transferActiveLease(
    sourceSessionId: string,
    targetSessionId: string,
    updatedAt: number,
  ) {
    return transferActiveLeaseWithDb(
      getDb(),
      sourceSessionId,
      targetSessionId,
      updatedAt,
    );
  },
  renameLease(fromSessionId: string, toSessionId: string, updatedAt: number) {
    return renameLeaseWithDb(getDb(), fromSessionId, toSessionId, updatedAt);
  },
  setLastError(
    sessionId: string,
    generation: number,
    error: string,
    updatedAt: number,
  ) {
    return setLastErrorWithDb(
      getDb(),
      sessionId,
      generation,
      error,
      updatedAt,
    );
  },
};
