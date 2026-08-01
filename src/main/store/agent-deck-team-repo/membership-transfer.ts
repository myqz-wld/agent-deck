import type { Database } from 'better-sqlite3';

import type { MemberRow } from './types';

export type TeammateMembershipTransferResult =
  | { transferred: true }
  | { transferred: false; reason: string };

/**
 * Atomically move one teammate membership to a handoff successor.
 *
 * A retry after a committed move is an idempotent success when the source is already left and the
 * successor is the active teammate. Existing successor display names win; otherwise the source
 * membership display name follows the ownership move.
 */
export function transferTeammateMembershipWithDb(
  db: Database,
  teamId: string,
  sourceSessionId: string,
  successorSessionId: string,
): TeammateMembershipTransferResult {
  if (sourceSessionId === successorSessionId) {
    return { transferred: false, reason: 'source-and-successor-match' };
  }

  try {
    return db.transaction(() => {
      const source = db
        .prepare(
          `SELECT * FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ?`,
        )
        .get(teamId, sourceSessionId) as MemberRow | undefined;
      const successor = db
        .prepare(
          `SELECT * FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ?`,
        )
        .get(teamId, successorSessionId) as MemberRow | undefined;

      if (!source) {
        return { transferred: false as const, reason: 'source-not-in-team' };
      }

      if (source.left_at !== null) {
        if (successor?.left_at === null && successor.role === 'teammate') {
          db.prepare(
            `UPDATE agent_deck_team_members
             SET display_name = COALESCE(display_name, ?)
             WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
          ).run(source.display_name, teamId, successorSessionId);
          return { transferred: true as const };
        }
        return { transferred: false as const, reason: 'source-not-active' };
      }

      if (source.role !== 'teammate') {
        return { transferred: false as const, reason: 'source-not-teammate' };
      }
      if (successor?.left_at === null && successor.role !== 'teammate') {
        return { transferred: false as const, reason: 'successor-active-as-lead' };
      }

      const now = Date.now();
      const sourceLeave = db.prepare(
        `UPDATE agent_deck_team_members
         SET left_at = ?
         WHERE team_id = ? AND session_id = ? AND role = 'teammate' AND left_at IS NULL`,
      ).run(now, teamId, sourceSessionId);
      if (sourceLeave.changes !== 1) {
        throw new Error('source membership changed during transfer');
      }

      if (!successor) {
        db.prepare(
          `INSERT INTO agent_deck_team_members
           (team_id, session_id, role, display_name, joined_at, left_at)
           VALUES (?, ?, 'teammate', ?, ?, NULL)`,
        ).run(teamId, successorSessionId, source.display_name, now);
      } else if (successor.left_at !== null) {
        db.prepare(
          `UPDATE agent_deck_team_members
           SET role = 'teammate', display_name = COALESCE(display_name, ?),
               joined_at = ?, left_at = NULL
           WHERE team_id = ? AND session_id = ?`,
        ).run(source.display_name, now, teamId, successorSessionId);
      } else {
        db.prepare(
          `UPDATE agent_deck_team_members
           SET display_name = COALESCE(display_name, ?)
           WHERE team_id = ? AND session_id = ? AND role = 'teammate' AND left_at IS NULL`,
        ).run(source.display_name, teamId, successorSessionId);
      }

      return { transferred: true as const };
    })();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { transferred: false, reason: `transfer-teammate-error: ${detail}` };
  }
}
