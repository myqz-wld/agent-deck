import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bindingAvailable } from '../__tests__/_binding-probe';
import { MIGRATIONS } from '../migrations';
import { StorageMaintenanceEngine } from './maintenance-engine';
import { runPassiveCheckpoint } from './maintenance-worker';
import {
  readMaintenanceState,
  updateMaintenanceState,
  type StorageMaintenanceTask,
} from './state';

interface FileDbFixture {
  root: string;
  path: string;
  writer: Database.Database;
  checkpoint: Database.Database;
  close(): void;
}

function openConnection(path: string): Database.Database {
  const db = new Database(path, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  return db;
}

function createWalFixture(): FileDbFixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-maintenance-worker-'));
  const path = join(root, 'agent-deck.db');
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec('CREATE TABLE wal_probe (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
  const checkpoint = openConnection(path);
  return {
    root,
    path,
    writer,
    checkpoint,
    close(): void {
      checkpoint.close();
      writer.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeWalBatch(db: Database.Database, rows = 64): void {
  const insert = db.prepare('INSERT INTO wal_probe(payload) VALUES (?)');
  const payload = Buffer.alloc(16 * 1024, 0x61);
  db.transaction(() => {
    for (let index = 0; index < rows; index += 1) insert.run(payload);
  })();
}

function createEngineFixture(): {
  root: string;
  db: Database.Database;
  eventId: number;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-maintenance-engine-'));
  const path = join(root, 'agent-deck.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
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
  const eventId = Number(db.prepare(
    `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
     VALUES ('s1', 'message', ?, 10, NULL)`,
  ).run(JSON.stringify({ text: 'engine restart marker' })).lastInsertRowid);
  db.exec(MIGRATIONS.find((migration) => migration.version === 41)!.sql);
  updateMaintenanceState(db, 'event-search-v1', { batchSize: 1 });
  updateMaintenanceState(db, 'file-snapshot-blobs-v1', { phase: 'complete' });
  return {
    root,
    db,
    eventId,
    close(): void {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!bindingAvailable)('maintenance worker checkpoint and engine integration', () => {
  it('reports a partial PASSIVE checkpoint without waiting for a pinned reader', () => {
    const fixture = createWalFixture();
    const reader = openConnection(fixture.path);
    try {
      runPassiveCheckpoint(fixture.checkpoint);
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM wal_probe').get();
      writeWalBatch(fixture.writer, 16);

      const blocked = runPassiveCheckpoint(fixture.checkpoint);
      expect(blocked).toMatchObject({ busy: 0 });
      expect(blocked.log).toBeGreaterThan(blocked.checkpointed);
      expect(blocked.durationMs).toBeGreaterThanOrEqual(0);

      reader.exec('COMMIT');
      const drained = runPassiveCheckpoint(fixture.checkpoint);
      expect(drained.busy).toBe(0);
      expect(drained.log).toBeGreaterThan(0);
      expect(drained.checkpointed).toBe(drained.log);
    } finally {
      if (reader.inTransaction) reader.exec('ROLLBACK');
      reader.close();
      fixture.close();
    }
  });

  it('bounds WAL growth when the worker connection owns periodic PASSIVE checkpoints', () => {
    const fixture = createWalFixture();
    try {
      expect(fixture.writer.pragma('wal_autocheckpoint', { simple: true })).toBe(0);
      runPassiveCheckpoint(fixture.checkpoint);
      let maxWalBytes = 0;
      for (let tick = 0; tick < 6; tick += 1) {
        writeWalBatch(fixture.writer);
        const checkpoint = runPassiveCheckpoint(fixture.checkpoint);
        expect(checkpoint.busy).toBe(0);
        expect(checkpoint.log).toBeGreaterThan(0);
        expect(checkpoint.checkpointed).toBe(checkpoint.log);
        maxWalBytes = Math.max(maxWalBytes, statSync(`${fixture.path}-wal`).size);
      }

      // Six ~1 MiB write periods reuse one checkpointed WAL region instead of accumulating ~6 MiB.
      expect(maxWalBytes).toBeGreaterThan(512 * 1024);
      expect(maxWalBytes).toBeLessThan(4 * 1024 * 1024);
    } finally {
      fixture.close();
    }
  });

  it('keeps restart eligibility frozen across replacement and safely resumes after result loss', () => {
    const fixture = createEngineFixture();
    try {
      const originalEligibility: StorageMaintenanceTask[] = [];
      const firstEngine = new StorageMaintenanceEngine(fixture.db, originalEligibility);

      // Commit succeeds, but pretend the caller lost this result before observing it.
      expect(firstEngine.runOneSlice()).toMatchObject({ phase: 'backfill', processed: 1 });
      expect(readMaintenanceState(fixture.db, 'event-search-v1')?.cursor)
        .toBe(fixture.eventId);
      expect(fixture.db.prepare(
        'SELECT COUNT(*) FROM event_search_fts_v1 WHERE rowid = ?',
      ).pluck().get(fixture.eventId)).toBe(1);

      // A replacement gets the original app-run snapshot. Durable cursor state makes the retry
      // idempotent: it advances to verification without duplicating or corrupting the candidate.
      const replacement = new StorageMaintenanceEngine(fixture.db, originalEligibility);
      expect(replacement.runOneSlice()).toMatchObject({ phase: 'verify', processed: 0 });
      expect(replacement.runOneSlice()).toMatchObject({ phase: 'awaiting-restart' });
      expect(replacement.runOneSlice()).toBeNull();
      expect(fixture.db.prepare(
        'SELECT COUNT(*) FROM event_search_fts_v1 WHERE rowid = ?',
      ).pluck().get(fixture.eventId)).toBe(1);

      // Replacing the worker is not an app restart, so reusing the original empty snapshot parks it.
      const sameRunReplacement = new StorageMaintenanceEngine(fixture.db, originalEligibility);
      expect(sameRunReplacement.runOneSlice()).toBeNull();
      expect(readMaintenanceState(fixture.db, 'event-search-v1')?.phase)
        .toBe('awaiting-restart');

      // A genuinely new app run captures awaiting-restart and is allowed to resume verification.
      const newRunEligibility = (['event-search-v1', 'file-snapshot-blobs-v1'] as const)
        .filter((task) => readMaintenanceState(fixture.db, task)?.phase === 'awaiting-restart');
      const newRun = new StorageMaintenanceEngine(fixture.db, newRunEligibility);
      const resumed = newRun.runTick();
      expect(resumed.restartTransitions).toEqual(['event-search-v1']);
      expect(resumed.result).toMatchObject({ phase: 'restart-verify', processed: 1 });
      expect(readMaintenanceState(fixture.db, 'event-search-v1')?.phase)
        .toBe('restart-verify');
    } finally {
      fixture.close();
    }
  });
});
