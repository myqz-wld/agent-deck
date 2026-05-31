import type { SummaryRecord } from '@shared/types';
import { getDb } from './db';

interface Row {
  id: number;
  session_id: string;
  content: string;
  trigger: string;
  ts: number;
}

function rowToRecord(r: Row): SummaryRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    content: r.content,
    trigger: r.trigger as SummaryRecord['trigger'],
    ts: r.ts,
  };
}

export const summaryRepo = {
  insert(rec: Omit<SummaryRecord, 'id'>): SummaryRecord {
    const info = getDb()
      .prepare(
        `INSERT INTO summaries (session_id, content, trigger, ts) VALUES (?, ?, ?, ?)`,
      )
      .run(rec.sessionId, rec.content, rec.trigger, rec.ts);
    return { ...rec, id: Number(info.lastInsertRowid) };
  },

  listForSession(sessionId: string, limit = 50): SummaryRecord[] {
    // 同毫秒 ts（同一 session 同一 ms 内连续插入两条 summary）SQLite 不保证返回顺序稳定，
    // 列表会在刷新后跳序。加自增 PK `id DESC` 作 secondary key（与 event-repo F3 /
    // file-change-repo REVIEW_2 同款修法，REVIEW_91 双 reviewer 独立共识）。
    const rows = getDb()
      .prepare(
        `SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Row[];
    return rows.map(rowToRecord);
  },

  latestForSession(sessionId: string): SummaryRecord | null {
    // 同毫秒 ts 时 `ORDER BY ts DESC LIMIT 1` 会返回较旧行，破坏「最新一条」语义 →
    // 加 `id DESC` tie-breaker 取同毫秒内最晚插入（REVIEW_91）。
    const row = getDb()
      .prepare(
        `SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as Row | undefined;
    return row ? rowToRecord(row) : null;
  },

  /**
   * 批量取多个会话各自的最新一条 summary。
   * 用窗口函数一次扫表，避免在 N 个会话上各发一条 query。
   */
  latestForSessions(sessionIds: string[]): Record<string, SummaryRecord> {
    if (sessionIds.length === 0) return {};
    const placeholders = sessionIds.map(() => '?').join(',');
    // ROW_NUMBER PARTITION 内同毫秒 ts 需 `id DESC` tie-breaker，否则同 session 同 ms
    // 两条 summary 取到旧的那条（ipc/sessions.ts:41 真实消费此查询，REVIEW_91）。
    const rows = getDb()
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, id DESC) AS rn
           FROM summaries
           WHERE session_id IN (${placeholders})
         ) WHERE rn = 1`,
      )
      .all(...sessionIds) as Row[];
    const out: Record<string, SummaryRecord> = {};
    for (const r of rows) {
      out[r.session_id] = rowToRecord(r);
    }
    return out;
  },
};
