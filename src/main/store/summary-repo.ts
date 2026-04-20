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
    const rows = getDb()
      .prepare(
        `SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Row[];
    return rows.map(rowToRecord);
  },

  latestForSession(sessionId: string): SummaryRecord | null {
    const row = getDb()
      .prepare(
        `SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC LIMIT 1`,
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
    const rows = getDb()
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC) AS rn
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
