import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from '../__tests__/_binding-probe';
import {
  beginEventSearchRestartVerification,
  retireLegacyEventSearchIndexOnShutdown,
  runEventSearchSlice,
} from './event-search';
import {
  beginSnapshotRestartVerification,
  prepareSnapshotGcIndexesOnShutdown,
  runSnapshotGcSlice,
  runSnapshotMaintenanceSlice,
} from './file-snapshots';
import { adaptBatchSize, readMaintenanceState, updateMaintenanceState } from './state';
import { isActiveMaintenancePhase } from './scheduler';
import { PAYLOAD_LIMITS, safeTruncateFileSnapshot } from '../payload-truncate';

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > 40) break;
    db.exec(migration.sql);
  }
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES ('s1', 'codex-cli', '/repo', 's1', 'sdk', 'active', 'idle', 1, 1)`,
  ).run();
  const insertEvent = db.prepare(
    `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
     VALUES ('s1', 'message', ?, ?, NULL)`,
  );
  insertEvent.run(JSON.stringify({ text: 'alpha legacy message' }), 10);
  insertEvent.run(JSON.stringify({ text: 'beta legacy message' }), 11);
  insertEvent.run(JSON.stringify({ text: 'gamma legacy message' }), 12);

  const insertChange = db.prepare(
    `INSERT INTO file_changes
      (session_id, file_path, kind, before_blob, after_blob, before_snapshot,
       after_snapshot, metadata_json, tool_call_id, ts)
     VALUES ('s1', ?, 'text', NULL, NULL, ?, ?, '{}', NULL, ?)`,
  );
  insertChange.run('/repo/a.ts', 'shared-before', 'after-a', 20);
  insertChange.run('/repo/b.ts', 'shared-before', 'after-b', 21);
  db.exec(MIGRATIONS.find((migration) => migration.version === 41)!.sql);
  return db;
}

function runUntil(
  readPhase: () => string | undefined,
  target: string,
  run: () => unknown,
  limit = 100,
): void {
  for (let index = 0; index < limit && readPhase() !== target; index += 1) run();
  expect(readPhase()).toBe(target);
}

describe.skipIf(!bindingAvailable)('staged storage maintenance', () => {
  it('backfills bounded search, verifies after restart, then retires legacy FTS on shutdown', () => {
    const db = legacyDb();
    try {
      updateMaintenanceState(db, 'event-search-v1', { batchSize: 1 });
      // A legacy row updated after migration is already present in the new index; backfill replaces
      // that rowid safely rather than duplicating it.
      db.prepare(`UPDATE events SET payload_json = ? WHERE id = 2`).run(
        JSON.stringify({ text: 'beta updated before backfill' }),
      );
      runUntil(
        () => readMaintenanceState(db, 'event-search-v1')?.phase,
        'awaiting-restart',
        () => runEventSearchSlice(db),
      );
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"updated"'`,
      ).pluck().all()).toEqual([2]);

      beginEventSearchRestartVerification(db);
      runUntil(
        () => readMaintenanceState(db, 'event-search-v1')?.phase,
        'retire-on-shutdown',
        () => runEventSearchSlice(db),
      );

      // The rollback index remains fully maintained during the verified app run.
      db.prepare(`UPDATE events SET payload_json = ? WHERE id = 1`).run(
        JSON.stringify({ text: 'alpha pending update' }),
      );
      expect(db.prepare(
        `SELECT rowid FROM events_fts WHERE events_fts MATCH '"pending"'`,
      ).pluck().all()).toEqual([1]);
      const retirement = retireLegacyEventSearchIndexOnShutdown(db);
      expect(retirement.retired).toBe(true);
      expect(readMaintenanceState(db, 'event-search-v1')?.phase).toBe('complete');
      expect(db.prepare(
        `SELECT rowid FROM events_fts WHERE events_fts MATCH '"pending"'`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"pending"'`,
      ).pluck().all()).toEqual([1]);

      // Compatibility legacy table remains queryable but no longer receives writes.
      db.prepare(`INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
        VALUES ('s1', 'message', ?, 13, NULL)`).run(
        JSON.stringify({ text: 'post retirement marker' }),
      );
      expect(db.prepare(
        `SELECT rowid FROM events_fts WHERE events_fts MATCH '"retirement"'`,
      ).all()).toEqual([]);
      expect(db.prepare(
        `SELECT rowid FROM event_search_fts_v1
          WHERE event_search_fts_v1 MATCH '"retirement"'`,
      ).pluck().all()).toEqual([4]);
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('blocks retirement when equal counts hide a missing event and an orphan FTS rowid', () => {
    const db = legacyDb();
    try {
      runUntil(
        () => readMaintenanceState(db, 'event-search-v1')?.phase,
        'awaiting-restart',
        () => runEventSearchSlice(db),
      );
      db.prepare('DELETE FROM event_search_fts_v1 WHERE rowid = 1').run();
      db.prepare(
        `INSERT INTO event_search_fts_v1(rowid, search_text) VALUES (999, 'phantom marker')`,
      ).run();
      expect(db.prepare('SELECT COUNT(*) FROM event_search_fts_v1').pluck().get()).toBe(
        db.prepare('SELECT COUNT(*) FROM events').pluck().get(),
      );

      beginEventSearchRestartVerification(db);
      expect(() => runEventSearchSlice(db)).toThrow(/missing eventId=1/);

      db.prepare(
        `INSERT INTO event_search_fts_v1(rowid, search_text)
          SELECT event_id, search_text FROM event_search_source_v1 WHERE event_id = 1`,
      ).run();
      runUntil(
        () => readMaintenanceState(db, 'event-search-v1')?.phase,
        'restart-verify-orphans',
        () => runEventSearchSlice(db),
      );
      expect(() => {
        runUntil(
          () => readMaintenanceState(db, 'event-search-v1')?.phase,
          'retire-on-shutdown',
          () => runEventSearchSlice(db),
        );
      }).toThrow(/orphan rowid=999/);
      expect(readMaintenanceState(db, 'event-search-v1')?.phase).not.toBe(
        'retire-on-shutdown',
      );
    } finally {
      db.close();
    }
  });

  it('deduplicates, verifies across a restart gate, clears legacy text, and defers blob GC', () => {
    const db = legacyDb();
    try {
      updateMaintenanceState(db, 'file-snapshot-blobs-v1', { batchSize: 1 });
      runUntil(
        () => readMaintenanceState(db, 'file-snapshot-blobs-v1')?.phase,
        'awaiting-restart',
        () => runSnapshotMaintenanceSlice(db),
      );
      expect(db.prepare('SELECT count(*) FROM file_snapshot_blobs').pluck().get()).toBe(3);
      expect(db.prepare(
        `SELECT count(DISTINCT hex(before_snapshot_hash)) FROM file_changes`,
      ).pluck().get()).toBe(1);
      expect(db.prepare(
        `SELECT count(*) FROM file_changes
          WHERE before_snapshot IS NOT NULL OR after_snapshot IS NOT NULL`,
      ).pluck().get()).toBe(2);

      beginSnapshotRestartVerification(db);
      runUntil(
        () => readMaintenanceState(db, 'file-snapshot-blobs-v1')?.phase,
        'indexes-on-shutdown',
        () => runSnapshotMaintenanceSlice(db),
      );
      expect(db.prepare(
        `SELECT count(*) FROM file_changes
          WHERE before_snapshot IS NOT NULL OR after_snapshot IS NOT NULL`,
      ).pluck().get()).toBe(0);

      expect(db.prepare(
        `SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'index' AND name LIKE 'idx_file_changes_%_snapshot_hash'`,
      ).pluck().get()).toBe(0);
      expect(prepareSnapshotGcIndexesOnShutdown(db).prepared).toBe(true);
      expect(readMaintenanceState(db, 'file-snapshot-blobs-v1')?.phase).toBe('complete');

      db.prepare(`DELETE FROM sessions WHERE id = 's1'`).run();
      expect(db.prepare('SELECT count(*) FROM file_snapshot_gc_queue').pluck().get()).toBe(3);
      while (Number(db.prepare('SELECT count(*) FROM file_snapshot_gc_queue').pluck().get()) > 0) {
        runSnapshotGcSlice(db, 1);
      }
      expect(db.prepare('SELECT count(*) FROM file_snapshot_blobs').pluck().get()).toBe(0);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('backfills an already-truncated v040 snapshot without applying truncation twice', () => {
    const db = legacyDb();
    try {
      const persisted = safeTruncateFileSnapshot(
        'x'.repeat(PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES + 16),
      )!;
      const inserted = db.prepare(
        `INSERT INTO file_changes
          (session_id, file_path, kind, before_blob, after_blob, before_snapshot,
           after_snapshot, metadata_json, tool_call_id, ts)
         VALUES ('s1', '/repo/large.ts', 'text', NULL, NULL, ?, NULL, '{}', NULL, 22)`,
      ).run(persisted);
      updateMaintenanceState(db, 'file-snapshot-blobs-v1', {
        upperBound: Number(inserted.lastInsertRowid),
        batchSize: 1,
      });

      runUntil(
        () => readMaintenanceState(db, 'file-snapshot-blobs-v1')?.phase,
        'awaiting-restart',
        () => runSnapshotMaintenanceSlice(db),
      );
      expect(db.prepare(
        `SELECT before_snapshot_hash IS NOT NULL FROM file_changes WHERE file_path = '/repo/large.ts'`,
      ).pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('adapts future batches around the maintenance slice target', () => {
    expect(adaptBatchSize(20, 30, { min: 5, max: 100, targetMs: 18 })).toBe(10);
    expect(adaptBatchSize(20, 5, { min: 5, max: 100, targetMs: 18 })).toBe(40);
    expect(adaptBatchSize(20, 15, { min: 5, max: 100, targetMs: 18 })).toBe(20);
  });

  it('parks restart and shutdown gates instead of spinning the scheduler at 40Hz', () => {
    expect(isActiveMaintenancePhase('backfill')).toBe(true);
    expect(isActiveMaintenancePhase('verify')).toBe(true);
    expect(isActiveMaintenancePhase('restart-verify')).toBe(true);
    expect(isActiveMaintenancePhase('restart-verify-orphans')).toBe(true);
    expect(isActiveMaintenancePhase('restart-verify-search')).toBe(true);
    expect(isActiveMaintenancePhase('awaiting-restart')).toBe(false);
    expect(isActiveMaintenancePhase('retire-on-shutdown')).toBe(false);
    expect(isActiveMaintenancePhase('complete')).toBe(false);
    expect(isActiveMaintenancePhase('future-corrupt-phase')).toBe(false);
  });
});
