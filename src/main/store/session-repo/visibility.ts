import { getDb } from '../db';

/** Mark a runtime session as permanently omitted from user-facing History queries. */
export function hideFromHistory(id: string): void {
  getDb().prepare(`UPDATE sessions SET hidden_from_history = 1 WHERE id = ?`).run(id);
}
