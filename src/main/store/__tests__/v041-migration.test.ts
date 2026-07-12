import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import { buildKeywordPredicate } from '../search-predicate';
import { bindingAvailable } from './_binding-probe';

function makeDbThrough(version: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
  return db;
}

function insertSession(db: Database.Database, id = 'session-1'): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', 'active', 'idle', 1, 1)`,
  ).run(id, id);
}

function insertEvent(
  db: Database.Database,
  payload: string,
  kind = 'message',
  toolUseId: string | null = null,
): number {
  return Number(db.prepare(
    `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
     VALUES ('session-1', ?, ?, 10, ?)`,
  ).run(kind, payload, toolUseId).lastInsertRowid);
}

describe.skipIf(!bindingAvailable)('v041 staged storage maintenance', () => {
  it('registers after v040 and leaves legacy rows for resumable backfill', () => {
    const v040Index = MIGRATIONS.findIndex((migration) => migration.version === 40);
    const v041Index = MIGRATIONS.findIndex((migration) => migration.version === 41);
    expect(v041Index).toBe(v040Index + 1);
    expect(MIGRATIONS[v041Index]).toMatchObject({
      version: 41,
      name: 'storage_maintenance_staging',
    });

    const db = makeDbThrough(40);
    try {
      insertSession(db);
      insertEvent(db, JSON.stringify({ text: 'legacy searchable message' }));
      db.prepare(
        `INSERT INTO file_changes
          (session_id, file_path, kind, before_blob, after_blob, before_snapshot,
           after_snapshot, metadata_json, tool_call_id, ts)
         VALUES ('session-1', '/repo/a.ts', 'text', NULL, NULL, 'before', 'after',
                 '{}', NULL, 20)`,
      ).run();

      db.exec(MIGRATIONS[v041Index].sql);

      expect(db.prepare('SELECT count(*) FROM event_search_fts_v1').pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM file_snapshot_blobs').pluck().get()).toBe(0);
      expect(db.prepare(
        `SELECT count(*) FROM sqlite_master
          WHERE type = 'index' AND name LIKE 'idx_file_changes_%_snapshot_hash'`,
      ).pluck().get()).toBe(0);
      expect(db.prepare(
        `SELECT task, phase, cursor, upper_bound FROM storage_maintenance_state ORDER BY task`,
      ).all()).toEqual([
        { task: 'event-search-v1', phase: 'backfill', cursor: 0, upper_bound: 1 },
        { task: 'file-snapshot-blobs-v1', phase: 'backfill', cursor: 0, upper_bound: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it('dual-writes bounded search text and safely handles updates, deletes, and malformed JSON', () => {
    const db = makeDbThrough(41);
    try {
      insertSession(db);
      const longMiddle = `${'x'.repeat(3_000)} middle-only-term ${'y'.repeat(3_000)}`;
      const eventId = insertEvent(db, JSON.stringify({
        toolName: 'Bash',
        toolInput: { command: 'rg needle src/main' },
        status: 'completed',
        toolResult: `head-marker ${longMiddle} tail-marker`,
      }), 'tool-use-end', 'tool-1');

      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"head-marker"'`,
      ).pluck().all()).toEqual([eventId]);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"tail-marker"'`,
      ).pluck().all()).toEqual([eventId]);
      const predicate = buildKeywordPredicate('head-marker');
      expect(db.prepare(`SELECT id FROM sessions WHERE ${predicate.sql}`).pluck().all(
        predicate.params,
      )).toEqual(['session-1']);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"middle-only-term"'`,
      ).all()).toEqual([]);

      db.prepare(`UPDATE events SET payload_json = ? WHERE id = ?`).run(
        JSON.stringify({ toolName: 'Bash', toolResult: 'replacement payload' }),
        eventId,
      );
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"head-marker"'`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"replacement"'`,
      ).pluck().all()).toEqual([eventId]);

      const malformedId = insertEvent(db, 'raw malformed searchable text');
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"malformed"'`,
      ).pluck().all()).toEqual([malformedId]);
      const malformedLongId = insertEvent(
        db,
        `malformed-head ${'x'.repeat(3_000)} malformed-middle ${'y'.repeat(3_000)} malformed-tail`,
      );
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"malformed-head"'`,
      ).pluck().all()).toEqual([malformedLongId]);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"malformed-middle"'`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"malformed-tail"'`,
      ).pluck().all()).toEqual([malformedLongId]);
      db.prepare('DELETE FROM events WHERE id IN (?, ?, ?)').run(
        eventId,
        malformedId,
        malformedLongId,
      );
      expect(db.prepare('SELECT count(*) FROM event_search_fts_v1').pluck().get()).toBe(0);
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('adds restricted snapshot references and queues cleanup without deleting blobs in cascade', () => {
    const db = makeDbThrough(41);
    try {
      insertSession(db);
      const raw = Buffer.from('snapshot payload');
      const digest = createHash('sha256').update(raw).digest();
      db.prepare(
        `INSERT INTO file_snapshot_blobs
          (digest, codec, raw_bytes, compressed_bytes, data)
         VALUES (?, 'deflate-raw-1', ?, ?, ?)`,
      ).run(digest, raw.length, 4, Buffer.from([1, 2, 3, 4]));
      db.prepare(
        `INSERT INTO file_changes
          (session_id, file_path, kind, before_blob, after_blob, before_snapshot,
           after_snapshot, metadata_json, tool_call_id, ts, before_snapshot_hash)
         VALUES ('session-1', '/repo/a.ts', 'text', NULL, NULL, NULL, NULL,
                 '{}', NULL, 20, ?)`,
      ).run(digest);

      expect(() =>
        db.prepare('DELETE FROM file_snapshot_blobs WHERE digest = ?').run(digest),
      ).toThrow();
      db.prepare(`DELETE FROM sessions WHERE id = 'session-1'`).run();
      expect(db.prepare('SELECT digest FROM file_snapshot_gc_queue').pluck().get()).toEqual(digest);
      expect(db.prepare('SELECT count(*) FROM file_snapshot_blobs').pluck().get()).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
