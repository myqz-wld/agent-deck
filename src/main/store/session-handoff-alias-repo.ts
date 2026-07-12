import type { Database } from 'better-sqlite3';
import { getDb } from './db';

export function recordSessionHandOffAliasWithDb(
  db: Database,
  sourceSessionId: string,
  successorSessionId: string,
  createdAt = Date.now(),
): void {
  if (sourceSessionId === successorSessionId) {
    throw new Error('handoff alias source and successor must differ');
  }
  db.prepare(
    `INSERT INTO session_handoff_aliases
       (source_session_id, successor_session_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(source_session_id) DO UPDATE SET
       successor_session_id = excluded.successor_session_id,
       created_at = excluded.created_at`,
  ).run(sourceSessionId, successorSessionId, createdAt);
}

/** Point every older direct predecessor at the outgoing owner's new successor. */
export function compressSessionHandOffAliasesWithDb(
  db: Database,
  sourceSessionId: string,
  successorSessionId: string,
): number {
  return db
    .prepare(
      `UPDATE session_handoff_aliases
          SET successor_session_id = ?
        WHERE successor_session_id = ?`,
    )
    .run(successorSessionId, sourceSessionId).changes;
}

export function findSessionHandOffSuccessorWithDb(
  db: Database,
  sourceSessionId: string,
): string | null {
  return (db
    .prepare(
      `SELECT successor_session_id
         FROM session_handoff_aliases
        WHERE source_session_id = ?`,
    )
    .pluck()
    .get(sourceSessionId) as string | undefined) ?? null;
}

export function findSessionHandOffSuccessor(sourceSessionId: string): string | null {
  return findSessionHandOffSuccessorWithDb(getDb(), sourceSessionId);
}

export function deleteSessionHandOffAliasWithDb(
  db: Database,
  sourceSessionId: string,
): boolean {
  return db
    .prepare(`DELETE FROM session_handoff_aliases WHERE source_session_id = ?`)
    .run(sourceSessionId).changes > 0;
}
