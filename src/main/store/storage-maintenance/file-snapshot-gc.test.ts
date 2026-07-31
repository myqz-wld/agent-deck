import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bindingAvailable } from '../__tests__/_binding-probe';
import { encodeFileSnapshot, FILE_SNAPSHOT_CODEC } from '../file-snapshot-codec';
import { CURRENT_SCHEMA_SQL } from '../schema';
import { runSnapshotGcSlice } from './file-snapshots';

function insertBlob(db: Database.Database, text: string): Buffer {
  const snapshot = encodeFileSnapshot(text)!;
  db.prepare(
    `INSERT INTO file_snapshot_blobs
       (digest, codec, raw_bytes, compressed_bytes, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    snapshot.digest,
    FILE_SNAPSHOT_CODEC,
    snapshot.rawBytes,
    snapshot.compressedBytes,
    snapshot.data,
  );
  return snapshot.digest;
}

describe.skipIf(!bindingAvailable)('file snapshot GC', () => {
  it('deletes orphaned blobs and preserves live references', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    db.exec(CURRENT_SCHEMA_SQL);
    try {
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('s1', 'codex-cli', '/repo', 's1', 'sdk', 'active', 'idle', 1, 1)`,
      ).run();
      const live = insertBlob(db, 'live');
      const orphan = insertBlob(db, 'orphan');
      db.prepare(
        `INSERT INTO file_changes
           (session_id, file_path, kind, metadata_json, ts, before_snapshot_hash)
         VALUES ('s1', '/repo/a.ts', 'text', '{}', 1, ?)`,
      ).run(live);
      const enqueue = db.prepare(
        `INSERT INTO file_snapshot_gc_queue (digest, queued_at) VALUES (?, ?)`,
      );
      enqueue.run(live, 1);
      enqueue.run(orphan, 2);

      expect(runSnapshotGcSlice(db, 10)).toMatchObject({
        phase: 'cleanup',
        processed: 2,
      });
      expect(
        db.prepare('SELECT COUNT(*) FROM file_snapshot_blobs WHERE digest = ?').pluck().get(live),
      ).toBe(1);
      expect(
        db.prepare('SELECT COUNT(*) FROM file_snapshot_blobs WHERE digest = ?').pluck().get(orphan),
      ).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });
});
