import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bindingAvailable } from '../__tests__/_binding-probe';
import { runPassiveCheckpoint } from './maintenance-worker';

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
});
