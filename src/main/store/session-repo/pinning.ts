import type { SessionRecord } from '@shared/types';
import { getDb } from '../db';
import { rowToRecord, type Row } from './types';

export type SessionPinStateErrorCode = 'missing' | 'not-live';

export class SessionPinStateError extends Error {
  readonly name = 'SessionPinStateError';

  constructor(
    readonly code: SessionPinStateErrorCode,
    sessionId: string,
  ) {
    super(
      code === 'missing'
        ? `cannot change pin state: session ${sessionId} does not exist`
        : `cannot pin session ${sessionId}: only unarchived active or dormant sessions are pinnable`,
    );
  }
}

/**
 * Set persistent pin state and return the committed row.
 *
 * Pinning a dormant live row reactivates it in the same statement. Repeated pin requests preserve
 * the original timestamp; unpin is allowed for any existing row so stale UI can always release it.
 */
export function setPinned(id: string, pinnedAt: number | null): SessionRecord {
  const db = getDb();
  return db.transaction(() => {
    const result =
      pinnedAt === null
        ? db.prepare(`UPDATE sessions SET pinned_at = NULL WHERE id = ?`).run(id)
        : db
            .prepare(
              `UPDATE sessions
               SET pinned_at = COALESCE(pinned_at, ?),
                   lifecycle = CASE WHEN lifecycle = 'dormant' THEN 'active' ELSE lifecycle END,
                   ended_at = CASE WHEN lifecycle = 'dormant' THEN NULL ELSE ended_at END
               WHERE id = ? AND archived_at IS NULL
                 AND lifecycle IN ('active', 'dormant')`,
            )
            .run(pinnedAt, id);

    if (result.changes !== 1) {
      const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(id);
      throw new SessionPinStateError(exists ? 'not-live' : 'missing', id);
    }
    const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row;
    return rowToRecord(row);
  })();
}
