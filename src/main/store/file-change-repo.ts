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
  // metadata_json 单条解析失败不能炸全列表（renderer 拉取走 .map(rowToRecord)，
  // 一条异常 → 整个 SessionDetail diff tab 抛错）。回落 {} + warn，让 dev 能看到
  // 但用户不受影响。REVIEW_2 修。
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
  } catch (err) {
    console.warn(
      `[file-change-repo] metadata_json parse failed for id=${r.id} session=${r.session_id}:`,
      err,
    );
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    filePath: r.file_path,
    kind: r.kind,
    beforeBlob: r.before_blob,
    afterBlob: r.after_blob,
    metadata,
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
    // 同毫秒写入（Edit + 紧跟 Read 触发的二次 file-changed）次序由 SQLite 内部决定，
    // 不稳定会让 SessionDetail 文件列表 / ChangeTimeline 在刷新后 row 顺序跳动。
    // 加 id DESC 作为 secondary key（自增 PK 单调），同 ts 也能稳定。REVIEW_2 修。
    const rows = getDb()
      .prepare(
        `SELECT * FROM file_changes WHERE session_id = ? ORDER BY ts DESC, id DESC`,
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
