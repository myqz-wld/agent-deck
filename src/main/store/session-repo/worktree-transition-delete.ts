import type Database from 'better-sqlite3';
import { deleteSessionHandOffAliasesForSessionWithDb } from '../session-handoff-alias-repo';

/** Delete one session without orphaning an unsettled worktree lease. */
export function deleteSessionWithWorktreeGuard(
  db: Database.Database,
  sessionId: string,
): void {
  db.transaction(() => {
    const unsettled = db
      .prepare(
        `SELECT generation, phase FROM worktree_cwd_transitions
         WHERE session_id = ? AND phase <> 'cleared'`,
      )
      .get(sessionId) as
      | { generation: number; phase: string }
      | undefined;
    if (unsettled) {
      throw new Error(
        `Cannot delete session ${sessionId} while worktree transition ` +
          `${sessionId}:${unsettled.generation} is ${unsettled.phase}.`,
      );
    }
    db.prepare(
      `DELETE FROM worktree_cwd_transition_inputs WHERE session_id = ?`,
    ).run(sessionId);
    db.prepare(
      `DELETE FROM worktree_cwd_transitions
       WHERE session_id = ? AND phase = 'cleared'`,
    ).run(sessionId);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    deleteSessionHandOffAliasesForSessionWithDb(db, sessionId);
  })();
}
