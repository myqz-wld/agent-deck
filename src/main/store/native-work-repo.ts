import type { Database } from 'better-sqlite3';
import type { AgentEvent } from '@shared/types';
import {
  NATIVE_WORK_PAGE_SIZE, nativeWorkAttemptKey, nativeWorkEntityKey,
  readNativeWorkDetail, readNativeWorkSnapshot, reduceNativeWork,
  type NativeWorkDetailParams, type NativeWorkDetailResult, type NativeWorkListResult, type NativeWorkListParams,
  type NativeWorkSnapshot,
} from '@shared/native-work';

interface Row { id: number; payload_json: string }
const parse = (json: string): unknown => { try { return JSON.parse(json); } catch { return null; } };

/** No schema changes: existing event revision triggers and parent deletion cascade apply. */
export function createNativeWorkRepo(db: Database) {
  const revision = (sessionId: string): number =>
    (db.prepare('SELECT revision FROM session_event_revisions WHERE session_id = ?')
      .get(sessionId) as { revision: number } | undefined)?.revision ?? 0;

  function insert(event: AgentEvent): number | null {
    if (event.kind !== 'background-task' && event.kind !== 'native-work-detail') return null;
    const detail = event.kind === 'native-work-detail' ? readNativeWorkDetail(event.payload) : null;
    const snapshot = event.kind === 'background-task' ? readNativeWorkSnapshot(event.payload) : null;
    if (!detail && !snapshot) {
      if (event.kind === 'native-work-detail') throw new Error('Invalid native work detail');
      return null; // Historical background snapshots retain their existing contract.
    }
    const payload = (detail ?? snapshot)!;
    if (payload.native.sessionId !== event.sessionId || payload.native.provider !== event.agentId) {
      throw new Error('Native work owner mismatch');
    }
    const key = JSON.stringify([nativeWorkAttemptKey(payload.native),
      ...(detail ? [detail.recordId, detail.part] : [])]);
    return db.transaction(() => {
      if (detail) {
        const siblings = db.prepare(`SELECT id, payload_json FROM events WHERE session_id = ?
          AND kind = 'native-work-detail' AND CASE WHEN json_valid(payload_json) THEN
          json_extract(payload_json, '$.native.provider') = ? AND
          json_extract(payload_json, '$.native.nativeId') = ? AND
          json_extract(payload_json, '$.native.runId') = ? AND
          json_extract(payload_json, '$.recordId') = ? ELSE 0 END`)
          .all(event.sessionId, detail.native.provider, detail.native.nativeId, detail.native.runId, detail.recordId) as Row[];
        for (const sibling of siblings) {
          const prior = readNativeWorkDetail(parse(sibling.payload_json));
          if (prior && prior.recordRevision > detail.recordRevision) return sibling.id;
        }
        // A shorter replacement must not leave the tail of the previous version in history.
        for (const sibling of siblings) {
          const prior = readNativeWorkDetail(parse(sibling.payload_json));
          if (prior && prior.recordRevision < detail.recordRevision && prior.part >= detail.parts) {
            db.prepare('DELETE FROM events WHERE id = ?').run(sibling.id);
          }
        }
      }
      const old = db.prepare('SELECT id, payload_json FROM events WHERE session_id = ? AND kind = ? AND tool_use_id = ? LIMIT 1')
        .get(event.sessionId, event.kind, key) as Row | undefined;
      if (old) {
        const previous = parse(old.payload_json);
        if (snapshot) {
          const state = readNativeWorkSnapshot(previous);
          if (state && reduceNativeWork(state, snapshot) === state) return old.id;
        } else if (detail) {
          const state = readNativeWorkDetail(previous);
          if (state && state.recordRevision >= detail.recordRevision) return old.id;
        }
        const encoded = JSON.stringify(payload);
        if (encoded !== old.payload_json) db.prepare('UPDATE events SET payload_json = ?, ts = ? WHERE id = ?')
          .run(encoded, event.ts, old.id);
        return old.id;
      }
      const result = db.prepare('INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id) VALUES (?, ?, ?, ?, ?)')
        .run(event.sessionId, event.kind, JSON.stringify(payload), event.ts, key);
      return Number(result.lastInsertRowid);
    })();
  }

  function list(sessionId: string, options: Omit<NativeWorkListParams, 'sessionId'> = {}): NativeWorkListResult {
    const tasks = new Map<string, NativeWorkSnapshot>();
    const ids = new Map<NativeWorkSnapshot, number>();
    const rows = db.prepare("SELECT id, payload_json FROM events WHERE session_id = ? AND kind = 'background-task' ORDER BY id ASC")
      .iterate(sessionId) as Iterable<Row>;
    for (const row of rows) {
      const task = readNativeWorkSnapshot(parse(row.payload_json));
      if (!task || task.native.sessionId !== sessionId || task.hidden) continue;
      const key = options.history ? nativeWorkAttemptKey(task.native) : nativeWorkEntityKey(task.native);
      const selected = reduceNativeWork(tasks.get(key), task);
      tasks.set(key, selected); ids.set(task, row.id);
    }
    const candidates = [...tasks.values()].filter(task => ids.get(task)! > (options.cursor ?? 0))
      .sort((a, b) => ids.get(a)! - ids.get(b)!);
    const limit = Math.max(1, Math.min(100, options.limit ?? 100));
    const page: NativeWorkSnapshot[] = []; let bytes = 0;
    for (const candidate of candidates.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (page.length && bytes + size > 2 * 1024 * 1024) break;
      page.push(candidate); bytes += size;
    }
    return { tasks: page, revision: revision(sessionId),
      nextCursor: candidates.length > page.length ? ids.get(page[page.length - 1])! : null };
  }

  function details({ ref, cursor = 0, limit = NATIVE_WORK_PAGE_SIZE }: NativeWorkDetailParams): NativeWorkDetailResult {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > NATIVE_WORK_PAGE_SIZE) {
      throw new Error('Invalid native work cursor');
    }
    const rows = db.prepare(`SELECT id, payload_json FROM events
      WHERE session_id = ? AND kind = 'native-work-detail' AND id > ?
        AND CASE WHEN json_valid(payload_json) THEN
          json_extract(payload_json, '$.native.provider') = ? AND
          json_extract(payload_json, '$.native.nativeId') = ? AND
          json_extract(payload_json, '$.native.runId') = ? ELSE 0 END
      ORDER BY id ASC LIMIT ?`).all(ref.sessionId, cursor, ref.provider, ref.nativeId, ref.runId, limit + 1) as Row[];
    const records: NativeWorkDetailResult['records'] = [];
    for (const row of rows.slice(0, limit)) {
      const value = readNativeWorkDetail(parse(row.payload_json));
      if (value && value.native.sessionId === ref.sessionId) records.push({ ...value, id: row.id });
    }
    return { records, nextCursor: rows.length > limit ? rows[limit - 1].id : null, revision: revision(ref.sessionId) };
  }
  return { insert, list, details };
}
