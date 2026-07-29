/**
 * Session lifecycle and activity persistence plus bounded cleanup queries.
 * Archive remains orthogonal to lifecycle.
 */

import type { ActivityState, LifecycleState, SessionRecord } from '@shared/types';
import { getDb } from '../db';
import { rowToRecord, type Row } from './types';

export const LIFECYCLE_BATCH_SIZE = 100;

export interface HistoryLifecycleCursor {
  lastEventAt: number;
  id: string;
}

export interface HistoryLifecycleCandidate extends HistoryLifecycleCursor {
  cliSessionId: string | null;
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return LIFECYCLE_BATCH_SIZE;
  return Math.max(1, Math.min(Math.floor(limit), LIFECYCLE_BATCH_SIZE));
}

export function setLifecycle(
  id: string,
  lifecycle: LifecycleState,
  ts: number,
  options: { clearPinned?: boolean } = {},
): void {
  const clearPinned = options.clearPinned === true;
  if (lifecycle === 'closed') {
    const sql = clearPinned
      ? `UPDATE sessions SET lifecycle = ?, ended_at = ?, pinned_at = NULL WHERE id = ?`
      : `UPDATE sessions SET lifecycle = ?, ended_at = ? WHERE id = ?`;
    getDb().prepare(sql).run(lifecycle, ts, id);
  } else {
    // active / dormant：清掉结束时间（不再「已结束」）。归档与否由 archived_at 单独管。
    const sql = clearPinned
      ? `UPDATE sessions SET lifecycle = ?, ended_at = NULL, pinned_at = NULL WHERE id = ?`
      : `UPDATE sessions SET lifecycle = ?, ended_at = NULL WHERE id = ?`;
    getDb().prepare(sql).run(lifecycle, id);
  }
}

export function setActivity(id: string, activity: ActivityState, lastEventAt: number): void {
  getDb()
    .prepare(`UPDATE sessions SET activity = ?, last_event_at = ? WHERE id = ?`)
    .run(activity, lastEventAt, id);
}

/** Persist one event-driven state transition; terminal events clear pin in the same statement. */
export function setEventState(
  id: string,
  activity: ActivityState,
  lifecycle: LifecycleState,
  lastEventAt: number,
  options: { clearPinned?: boolean } = {},
): void {
  const endedAt = lifecycle === 'closed' ? lastEventAt : null;
  const sql = options.clearPinned
    ? `UPDATE sessions
       SET activity = ?, lifecycle = ?, last_event_at = ?, ended_at = ?, pinned_at = NULL
       WHERE id = ?`
    : `UPDATE sessions
       SET activity = ?, lifecycle = ?, last_event_at = ?, ended_at = ?
       WHERE id = ?`;
  getDb().prepare(sql).run(activity, lifecycle, lastEventAt, endedAt, id);
}

/** lifecycle scheduler 用：找出所有可能要从 active → dormant 的未归档、未 pin 会话。 */
export function findActiveExpiring(
  threshold: number,
  limit = LIFECYCLE_BATCH_SIZE,
): SessionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE lifecycle = 'active' AND archived_at IS NULL
         AND pinned_at IS NULL AND last_event_at < ?
       ORDER BY last_event_at ASC, id ASC
       LIMIT ?`,
    )
    .all(threshold, boundedLimit(limit)) as Row[];
  return rows.map(rowToRecord);
}

/** lifecycle scheduler 用：找出所有可能要从 dormant → closed 的未归档、未 pin 会话。 */
export function findDormantExpiring(
  threshold: number,
  limit = LIFECYCLE_BATCH_SIZE,
): SessionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE lifecycle = 'dormant' AND archived_at IS NULL
         AND pinned_at IS NULL AND last_event_at < ?
       ORDER BY last_event_at ASC, id ASC
       LIMIT ?`,
    )
    .all(threshold, boundedLimit(limit)) as Row[];
  return rows.map(rowToRecord);
}

/**
 * lifecycle scheduler 批量推进：单事务里把多个 sessionId 的 lifecycle
 * 一次推到目标态，避免每条都跑「get → setLifecycle → get → emit」3 次 SQL。
 * 返回真正发生状态变化的行（再让上层 emit upserted 通知 renderer）。
 *
 * SQL 不用动态拼 IN(?, ?, ?) —— 一次性 prepare + transaction 内多次 run，
 * better-sqlite3 内部会复用 statement，比拼 IN 更稳。
 */
export function batchAdvanceLifecycle(
  ids: readonly string[],
  fromLifecycle: 'active' | 'dormant',
  toLifecycle: 'dormant' | 'closed',
  ts: number,
  inactivityBefore: number,
): SessionRecord[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const update = db.prepare(
    `UPDATE sessions
     SET lifecycle = ?, ended_at = ?
     WHERE id = ? AND lifecycle = ? AND archived_at IS NULL
       AND pinned_at IS NULL AND last_event_at < ?`,
  );
  const fetch = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const updated: SessionRecord[] = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const endedAt = toLifecycle === 'closed' ? ts : null;
      const info = update.run(toLifecycle, endedAt, id, fromLifecycle, inactivityBefore);
      if (info.changes === 1) {
        const row = fetch.get(id) as Row | undefined;
        if (row) updated.push(rowToRecord(row));
      }
    }
  });
  tx();
  return updated;
}

/**
 * Page closed or archived cleanup candidates strictly after the
 * `(lastEventAt, id)` cursor. Returning both identities lets the caller skip
 * live-owned rows without starving later candidates and fence successful
 * deletes. Active and dormant sessions are never purge candidates.
 */
export function findHistoryOlderThan(
  threshold: number,
  cursor: HistoryLifecycleCursor | null = null,
  limit = LIFECYCLE_BATCH_SIZE,
): HistoryLifecycleCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT id, cli_session_id, last_event_at FROM sessions
       WHERE pinned_at IS NULL AND last_event_at < ?
         AND (lifecycle = 'closed' OR archived_at IS NOT NULL)
         AND (? IS NULL OR last_event_at > ?
           OR (last_event_at = ? AND id > ?))
       ORDER BY last_event_at ASC, id ASC
       LIMIT ?`,
    )
    .all(
      threshold,
      cursor?.id ?? null,
      cursor?.lastEventAt ?? 0,
      cursor?.lastEventAt ?? 0,
      cursor?.id ?? '',
      boundedLimit(limit),
    ) as Array<{ id: string; cli_session_id: string | null; last_event_at: number }>;
  return rows.map((row) => ({
    id: row.id,
    cliSessionId: row.cli_session_id,
    lastEventAt: row.last_event_at,
  }));
}

/**
 * Recheck cleanup predicates while deleting one bounded batch transactionally.
 * Return only successful candidates so the caller can synchronously fence both
 * identities before any asynchronous cleanup.
 */
export function batchDeleteHistory(
  candidates: readonly HistoryLifecycleCandidate[],
  threshold: number,
): HistoryLifecycleCandidate[] {
  if (candidates.length === 0) return [];
  const db = getDb();
  const del = db.prepare(
    `DELETE FROM sessions
     WHERE id = ? AND pinned_at IS NULL AND last_event_at < ?
       AND (lifecycle = 'closed' OR archived_at IS NOT NULL)`,
  );
  const removed: HistoryLifecycleCandidate[] = [];
  const tx = db.transaction(() => {
    for (const candidate of candidates) {
      const result = del.run(candidate.id, threshold);
      if (result.changes === 1) removed.push(candidate);
    }
  });
  tx();
  return removed;
}
