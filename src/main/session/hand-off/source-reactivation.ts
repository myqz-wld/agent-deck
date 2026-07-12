import { getDb } from '@main/store/db';
import { deleteSessionHandOffAliasWithDb } from '@main/store/session-handoff-alias-repo';
import { handOffCutoverCoordinator } from './cutover-coordinator';

/**
 * Start a new source ownership epoch atomically: the row cannot become active while its durable
 * alias still redirects, and a persistence failure cannot sever the old wire anchor.
 */
export function reactivateHandOffSource(
  sessionId: string,
  persistReactivation: () => void,
): void {
  const db = getDb();
  db.transaction(() => {
    persistReactivation();
    deleteSessionHandOffAliasWithDb(db, sessionId);
  })();
  handOffCutoverCoordinator.reactivateSource(sessionId);
}
