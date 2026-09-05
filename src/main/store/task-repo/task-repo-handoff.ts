import type { Database } from 'better-sqlite3';
import type { TaskRepo } from './_deps';

export function createHandoff(db: Database): Pick<TaskRepo, 'reassignOwner'> {
  return {
    reassignOwner(oldSessionId, newSessionId) {
      // Ownership transfer preserves team membership, dependency edges and list order.
      // The destination session must already exist; its FK rejects partial transfers.
      const result = db.prepare(
        'UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?',
      ).run(newSessionId, oldSessionId);
      return Number(result.changes);
    },
  };
}
