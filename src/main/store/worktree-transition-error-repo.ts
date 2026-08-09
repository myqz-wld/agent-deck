import type Database from 'better-sqlite3';

import { WORKTREE_CLEANUP_UNPROVED_MARKER } from '@main/session/worktree-transition/constants';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';

import {
  getWorktreeTransitionWithDb,
  requireWorktreeTransitionGeneration,
  WorktreeTransitionConflictError,
} from './worktree-transition-row';

export function setLastErrorWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
  error: string,
  updatedAt: number,
): WorktreeTransitionRecord {
  const markerPrefix = `${WORKTREE_CLEANUP_UNPROVED_MARKER}:`;
  const requestedMarker = error.startsWith(markerPrefix);
  const detail = requestedMarker ? error.slice(markerPrefix.length).trimStart() : error;
  const markedError = `${markerPrefix} ${detail}`;
  const result = db
    .prepare(
      `UPDATE worktree_cwd_transitions
       SET last_error = CASE
             WHEN ? = 1 OR substr(last_error, 1, ?) = ? THEN ?
             ELSE ?
           END,
           updated_at = ?
       WHERE session_id = ? AND generation = ?`,
    )
    .run(
      requestedMarker ? 1 : 0,
      markerPrefix.length,
      markerPrefix,
      markedError,
      error,
      updatedAt,
      sessionId,
      generation,
    );
  if (result.changes !== 1) {
    requireWorktreeTransitionGeneration(db, sessionId, generation);
  }
  return getWorktreeTransitionWithDb(db, sessionId)!;
}

export function clearCleanupUnprovedLastErrorWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
  error: string,
  updatedAt: number,
): WorktreeTransitionRecord {
  const current = requireWorktreeTransitionGeneration(db, sessionId, generation);
  const markerPrefix = `${WORKTREE_CLEANUP_UNPROVED_MARKER}:`;
  if (!current.lastError?.startsWith(markerPrefix)) {
    throw new WorktreeTransitionConflictError(
      sessionId,
      current.generation,
      current.phase,
      `Worktree cleanup proof marker is absent for ${sessionId}:${generation}.`,
    );
  }
  const result = db
    .prepare(
      `UPDATE worktree_cwd_transitions SET last_error = ?, updated_at = ?
       WHERE session_id = ? AND generation = ? AND last_error = ?`,
    )
    .run(error, updatedAt, sessionId, generation, current.lastError);
  if (result.changes !== 1) {
    const changed = requireWorktreeTransitionGeneration(db, sessionId, generation);
    throw new WorktreeTransitionConflictError(
      sessionId,
      changed.generation,
      changed.phase,
      `Worktree cleanup proof marker changed for ${sessionId}:${generation}.`,
    );
  }
  return getWorktreeTransitionWithDb(db, sessionId)!;
}
