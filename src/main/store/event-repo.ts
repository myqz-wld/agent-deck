import type { AgentEvent } from '@shared/types';
import { getDb } from './db';

interface Row {
  id: number;
  session_id: string;
  kind: string;
  payload_json: string;
  ts: number;
}

function rowToEvent(r: Row): AgentEvent & { id: number } {
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: '', // events 表不冗余 agent_id；调用者通过 session join 拿
    kind: r.kind as AgentEvent['kind'],
    payload: JSON.parse(r.payload_json) as unknown,
    ts: r.ts,
  };
}

export const eventRepo = {
  insert(event: AgentEvent): number {
    const info = getDb()
      .prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.sessionId, event.kind, JSON.stringify(event.payload ?? null), event.ts);
    return Number(info.lastInsertRowid);
  },

  listForSession(sessionId: string, limit = 200, offset = 0): (AgentEvent & { id: number })[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?`,
      )
      .all(sessionId, limit, offset) as Row[];
    return rows.map(rowToEvent);
  },

  countForSession(sessionId: string, sinceTs?: number): number {
    if (sinceTs) {
      const r = getDb()
        .prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ? AND ts >= ?`)
        .get(sessionId, sinceTs) as { c: number };
      return r.c;
    }
    const r = getDb()
      .prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ?`)
      .get(sessionId) as { c: number };
    return r.c;
  },

  deleteForSession(sessionId: string): void {
    getDb().prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
  },
};
