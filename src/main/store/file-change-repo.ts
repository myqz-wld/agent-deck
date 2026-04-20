import type { FileChangeRecord } from '@shared/types';
import { getDb } from './db';

interface Row {
  id: number;
  session_id: string;
  file_path: string;
  kind: string;
  before_blob: string | null;
  after_blob: string | null;
  metadata_json: string;
  tool_call_id: string | null;
  ts: number;
}

function rowToRecord(r: Row): FileChangeRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    filePath: r.file_path,
    kind: r.kind,
    beforeBlob: r.before_blob,
    afterBlob: r.after_blob,
    metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
    toolCallId: r.tool_call_id,
    ts: r.ts,
  };
}

export const fileChangeRepo = {
  insert(rec: Omit<FileChangeRecord, 'id'>): number {
    const info = getDb()
      .prepare(
        `INSERT INTO file_changes
         (session_id, file_path, kind, before_blob, after_blob, metadata_json, tool_call_id, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.sessionId,
        rec.filePath,
        rec.kind,
        rec.beforeBlob,
        rec.afterBlob,
        JSON.stringify(rec.metadata ?? {}),
        rec.toolCallId,
        rec.ts,
      );
    return Number(info.lastInsertRowid);
  },

  listForSession(sessionId: string): FileChangeRecord[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM file_changes WHERE session_id = ? ORDER BY ts DESC`,
      )
      .all(sessionId) as Row[];
    return rows.map(rowToRecord);
  },

  countForSession(sessionId: string): number {
    const r = getDb()
      .prepare(`SELECT COUNT(*) as c FROM file_changes WHERE session_id = ?`)
      .get(sessionId) as { c: number };
    return r.c;
  },
};
