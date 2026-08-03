import type Database from 'better-sqlite3';
import {
  assertDirectionMatchesPhase,
  assertWorktreeTransitionStep,
} from '@main/session/worktree-transition/state-machine';
import type {
  WorktreeTransitionDirection,
  WorktreeTransitionPhase,
  WorktreeTransitionRecord,
} from '@main/session/worktree-transition/types';
import {
  getWorktreeTransitionWithDb,
  requireWorktreeTransitionGeneration,
  WorktreeTransitionConflictError,
} from './worktree-transition-row';

export interface WorktreeTransitionDrainResult {
  settled: boolean;
  record: WorktreeTransitionRecord;
}

export interface PhaseSettlementInput {
  sessionId: string;
  generation: number;
  expected: WorktreeTransitionPhase;
  next: 'active' | 'cleared';
  updatedAt: number;
  lastError?: string | null;
}

export interface InputSealInput {
  sessionId: string;
  generation: number;
  expected: 'cleanup_pending';
  updatedAt: number;
  lastError: string;
}

function requireExpectedPhase(
  db: Database.Database,
  input: Pick<PhaseSettlementInput, 'sessionId' | 'generation' | 'expected'>,
): WorktreeTransitionRecord {
  const current = requireWorktreeTransitionGeneration(
    db,
    input.sessionId,
    input.generation,
  );
  if (current.phase !== input.expected) {
    throw new WorktreeTransitionConflictError(
      input.sessionId,
      current.generation,
      current.phase,
      `Expected worktree transition ${input.sessionId}:${input.generation} in phase ${input.expected}, found ${current.phase}.`,
    );
  }
  return current;
}

function hasPendingInput(
  db: Database.Database,
  sessionId: string,
  generation: number,
): boolean {
  return db
    .prepare(
      `SELECT 1 FROM worktree_cwd_transition_inputs
       WHERE session_id = ? AND generation = ? AND delivered_at IS NULL
       LIMIT 1`,
    )
    .get(sessionId, generation) !== undefined;
}

/** Atomically close ingress and settle a phase only when every accepted input was replayed. */
export function settleWorktreeTransitionAfterInputDrainWithDb(
  db: Database.Database,
  input: PhaseSettlementInput,
): WorktreeTransitionDrainResult {
  return db.transaction(() => {
    const current = requireExpectedPhase(db, input);
    if (hasPendingInput(db, input.sessionId, input.generation)) {
      return { settled: false, record: current };
    }
    if (
      ((input.expected === 'switching_to_worktree' &&
        input.next === 'active') ||
        input.expected === 'cleanup_pending') &&
      !current.continuationDelivered
    ) {
      throw new Error(
        `Cannot settle worktree transition ${input.sessionId}:${input.generation} before its continuation is accepted.`,
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
             tool_use_id = NULL,
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
      const latest = getWorktreeTransitionWithDb(db, input.sessionId);
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        latest?.generation ?? null,
        latest?.phase ?? null,
        `Input-drain settlement lost for worktree transition ${input.sessionId}:${input.generation}.`,
      );
    }
    return {
      settled: true,
      record: getWorktreeTransitionWithDb(db, input.sessionId)!,
    };
  })();
}

/** Keep cleanup authority while atomically closing transition-buffer ingress after a failed exit. */
export function sealWorktreeTransitionInputAfterDrainWithDb(
  db: Database.Database,
  input: InputSealInput,
): WorktreeTransitionDrainResult {
  return db.transaction(() => {
    const current = requireExpectedPhase(db, input);
    if (hasPendingInput(db, input.sessionId, input.generation)) {
      return { settled: false, record: current };
    }
    if (!current.continuationDelivered) {
      throw new Error(
        `Cannot seal worktree transition input ${input.sessionId}:${input.generation} before its continuation is accepted.`,
      );
    }
    const result = db
      .prepare(
        `UPDATE worktree_cwd_transitions
         SET tool_use_id = NULL, updated_at = ?, last_error = ?
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
      const latest = getWorktreeTransitionWithDb(db, input.sessionId);
      throw new WorktreeTransitionConflictError(
        input.sessionId,
        latest?.generation ?? null,
        latest?.phase ?? null,
        `Input-buffer seal lost for worktree transition ${input.sessionId}:${input.generation}.`,
      );
    }
    return {
      settled: true,
      record: getWorktreeTransitionWithDb(db, input.sessionId)!,
    };
  })();
}
