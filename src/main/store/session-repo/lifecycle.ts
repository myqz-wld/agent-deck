/**
 * session-repo —— lifecycle 推进 + activity / 历史清理批量操作。
 * 与 archive 正交（archive 见 archive.ts）；lifecycle scheduler 主要消费此文件。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 */

import type { ActivityState, LifecycleState, SessionRecord } from '@shared/types';
import { getDb } from '../db';
import { rowToRecord, type Row } from './types';

export function setLifecycle(id: string, lifecycle: LifecycleState, ts: number): void {
  if (lifecycle === 'closed') {
    getDb()
      .prepare(`UPDATE sessions SET lifecycle = ?, ended_at = ? WHERE id = ?`)
      .run(lifecycle, ts, id);
  } else {
    // active / dormant：清掉结束时间（不再「已结束」）。归档与否由 archived_at 单独管。
    getDb()
      .prepare(`UPDATE sessions SET lifecycle = ?, ended_at = NULL WHERE id = ?`)
      .run(lifecycle, id);
  }
}

export function setActivity(id: string, activity: ActivityState, lastEventAt: number): void {
  getDb()
    .prepare(`UPDATE sessions SET activity = ?, last_event_at = ? WHERE id = ?`)
    .run(activity, lastEventAt, id);
}

/** lifecycle scheduler 用：找出所有可能要从 active → dormant 的会话；归档的不参与衰减 */
export function findActiveExpiring(threshold: number): SessionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions WHERE lifecycle = 'active' AND archived_at IS NULL AND last_event_at < ?`,
    )
    .all(threshold) as Row[];
  return rows.map(rowToRecord);
}

/** lifecycle scheduler 用：找出所有可能要从 dormant → closed 的会话；归档的不参与衰减 */
export function findDormantExpiring(threshold: number): SessionRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions WHERE lifecycle = 'dormant' AND archived_at IS NULL AND last_event_at < ?`,
    )
    .all(threshold) as Row[];
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
export function batchSetLifecycle(
  ids: readonly string[],
  lifecycle: LifecycleState,
  ts: number,
): SessionRecord[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const updateClosed = db.prepare(
    `UPDATE sessions SET lifecycle = ?, ended_at = ? WHERE id = ? AND lifecycle != ?`,
  );
  const updateOther = db.prepare(
    `UPDATE sessions SET lifecycle = ?, ended_at = NULL WHERE id = ? AND lifecycle != ?`,
  );
  const fetch = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const updated: SessionRecord[] = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const info =
        lifecycle === 'closed'
          ? updateClosed.run(lifecycle, ts, id, lifecycle)
          : updateOther.run(lifecycle, id, lifecycle);
      if (info.changes > 0) {
        const row = fetch.get(id) as Row | undefined;
        if (row) updated.push(rowToRecord(row));
      }
    }
  });
  tx();
  return updated;
}

/**
 * 历史会话自动清理：找出 lastEventAt < threshold 且不在实时面板的会话 id。
 * 「不在实时面板」= lifecycle = 'closed' 或 archived_at IS NOT NULL，
 * 与 listHistory 的范围一致。active / dormant 即便最后事件很久也不删
 * （用户可能开着窗口在等长任务），由 LifecycleScheduler 先推到 closed 再考虑清理。
 */
export function findHistoryOlderThan(threshold: number, limit = 500): string[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM sessions
       WHERE last_event_at < ?
         AND (lifecycle = 'closed' OR archived_at IS NOT NULL)
       ORDER BY last_event_at ASC
       LIMIT ?`,
    )
    .all(threshold, limit) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * 批量删除会话（events / file_changes / summaries 由外键 ON DELETE CASCADE 自动清理）。
 * 单事务内逐条 DELETE，事务保证「要么全删要么全不删」，避免中途异常留下半残行。
 * 返回 IPC 上层用来一次性广播 session-removed 的 id 数组（已存在的才返回）。
 */
export function batchDelete(ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
  const del = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  const removed: string[] = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (exists.get(id)) {
        del.run(id);
        removed.push(id);
      }
    }
  });
  tx();
  return removed;
}
