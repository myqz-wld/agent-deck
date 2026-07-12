import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bindingAvailable } from '../__tests__/_binding-probe';
import { encodePersistedFileSnapshot, FILE_SNAPSHOT_CODEC } from '../file-snapshot-codec';
import { MIGRATIONS } from '../migrations';
import {
  runSnapshotGcSlice,
  runSnapshotMaintenanceSlice,
} from './file-snapshots';
import { readMaintenanceState, updateMaintenanceState } from './state';

interface WalFixture {
  dir: string;
  dbPath: string;
  maintenance: Database.Database;
  ingress: Database.Database;
}

const requireFromTest = createRequire(import.meta.url);
const betterSqlitePath = requireFromTest.resolve('better-sqlite3');

function configureConnection(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  db.pragma('busy_timeout = 5000');
}

function createWalFixture(): WalFixture {
  const dir = mkdtempSync(join(tmpdir(), 'agent-deck-snapshot-concurrency-'));
  const dbPath = join(dir, 'agent-deck.db');
  const maintenance = new Database(dbPath);
  maintenance.pragma('journal_mode = WAL');
  configureConnection(maintenance);
  for (const migration of MIGRATIONS) {
    if (migration.version > 40) break;
    maintenance.exec(migration.sql);
  }
  maintenance.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES ('s1', 'codex-cli', '/repo', 's1', 'sdk', 'active', 'idle', 1, 1)`,
  ).run();
  maintenance.prepare(
    `INSERT INTO file_changes
      (session_id, file_path, kind, before_blob, after_blob, before_snapshot,
       after_snapshot, metadata_json, tool_call_id, ts)
     VALUES ('s1', '/repo/legacy.ts', 'text', NULL, NULL, 'before-v40', 'after-v40',
             '{}', NULL, 10)`,
  ).run();
  maintenance.exec(MIGRATIONS.find((migration) => migration.version === 41)!.sql);

  const ingress = new Database(dbPath);
  configureConnection(ingress);
  return { dir, dbPath, maintenance, ingress };
}

function closeWalFixture(fixture: WalFixture): void {
  if (fixture.ingress.open) fixture.ingress.close();
  if (fixture.maintenance.open) fixture.maintenance.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

describe.skipIf(!bindingAvailable)('snapshot maintenance WAL concurrency', () => {
  it('skips a concurrently cascade-deleted row without leaking an unqueued blob', () => {
    const fixture = createWalFixture();
    try {
      const result = runSnapshotMaintenanceSlice(fixture.maintenance, {
        beforeBackfillWrite: () => {
          fixture.ingress.prepare(`DELETE FROM sessions WHERE id = 's1'`).run();
        },
      });

      expect(result).toMatchObject({ phase: 'backfill', processed: 1 });
      expect(fixture.maintenance.prepare('SELECT COUNT(*) FROM file_changes').pluck().get()).toBe(0);
      expect(
        fixture.maintenance.prepare('SELECT COUNT(*) FROM file_snapshot_blobs').pluck().get(),
      ).toBe(0);
      expect(
        fixture.maintenance.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get(),
      ).toBe(0);
      expect(readMaintenanceState(fixture.maintenance, 'file-snapshot-blobs-v1')?.cursor).toBe(1);
      expect(fixture.maintenance.pragma('foreign_key_check')).toEqual([]);
      expect(fixture.maintenance.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      closeWalFixture(fixture);
    }
  });

  it('rolls back data and cursor when legacy text changes after encoding', () => {
    const fixture = createWalFixture();
    try {
      expect(() =>
        runSnapshotMaintenanceSlice(fixture.maintenance, {
          beforeBackfillWrite: () => {
            fixture.ingress.prepare(
              `UPDATE file_changes SET before_snapshot = 'changed-after-encode' WHERE id = 1`,
            ).run();
          },
        }),
      ).toThrow(/snapshot source changed during backfill/);

      expect(readMaintenanceState(fixture.maintenance, 'file-snapshot-blobs-v1')?.cursor).toBe(0);
      expect(
        fixture.maintenance.prepare('SELECT COUNT(*) FROM file_snapshot_blobs').pluck().get(),
      ).toBe(0);

      runSnapshotMaintenanceSlice(fixture.maintenance);
      const expected = encodePersistedFileSnapshot('changed-after-encode')!;
      const storedHash = fixture.maintenance.prepare(
        'SELECT before_snapshot_hash FROM file_changes WHERE id = 1',
      ).pluck().get();
      expect(storedHash).toEqual(expected.digest);
      expect(readMaintenanceState(fixture.maintenance, 'file-snapshot-blobs-v1')?.cursor).toBe(1);
      expect(fixture.maintenance.pragma('foreign_key_check')).toEqual([]);
    } finally {
      closeWalFixture(fixture);
    }
  });

  it('waits for a concurrent reference writer before GC probes and deletes', async () => {
    const fixture = createWalFixture();
    let writer: Worker | null = null;
    try {
      const encoded = encodePersistedFileSnapshot('gc-shared-snapshot')!;
      fixture.maintenance.prepare(
        `INSERT INTO file_snapshot_blobs
          (digest, codec, raw_bytes, compressed_bytes, data) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        encoded.digest,
        FILE_SNAPSHOT_CODEC,
        encoded.rawBytes,
        encoded.compressedBytes,
        encoded.data,
      );
      fixture.maintenance.prepare(
        `INSERT INTO file_snapshot_gc_queue(digest, queued_at) VALUES (?, 1)`,
      ).run(encoded.digest);
      updateMaintenanceState(fixture.maintenance, 'file-snapshot-blobs-v1', {
        phase: 'complete',
      });

      writer = new Worker(REFERENCE_WRITER_SOURCE, {
        eval: true,
        workerData: {
          betterSqlitePath,
          dbPath: fixture.dbPath,
          digestHex: encoded.digestHex,
        },
      });
      const exitPromise = once(writer, 'exit');
      const [message] = await once(writer, 'message');
      expect(message).toEqual({ type: 'locked' });

      const result = runSnapshotGcSlice(fixture.maintenance, 1);
      const [exitCode] = await exitPromise;
      expect(exitCode).toBe(0);
      expect(result).toMatchObject({ phase: 'cleanup', processed: 1 });
      expect(
        fixture.maintenance.prepare('SELECT COUNT(*) FROM file_snapshot_blobs').pluck().get(),
      ).toBe(1);
      expect(
        fixture.maintenance.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get(),
      ).toBe(0);
      expect(
        fixture.maintenance.prepare(
          `SELECT COUNT(*) FROM file_changes WHERE before_snapshot_hash = ?`,
        ).pluck().get(encoded.digest),
      ).toBe(1);
      expect(fixture.maintenance.pragma('foreign_key_check')).toEqual([]);
    } finally {
      if (writer) await writer.terminate();
      closeWalFixture(fixture);
    }
  }, 10_000);
});

const REFERENCE_WRITER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require(workerData.betterSqlitePath);
  const db = new Database(workerData.dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  db.pragma('busy_timeout = 5000');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      "INSERT INTO file_changes " +
      "(session_id, file_path, kind, before_blob, after_blob, before_snapshot, " +
      " after_snapshot, before_snapshot_hash, after_snapshot_hash, metadata_json, " +
      " tool_call_id, ts) " +
      "VALUES ('s1', '/repo/concurrent.ts', 'text', NULL, NULL, NULL, NULL, ?, NULL, '{}', NULL, 20)"
    ).run(Buffer.from(workerData.digestHex, 'hex'));
    parentPort.postMessage({ type: 'locked' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
`;
