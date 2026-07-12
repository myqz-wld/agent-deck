import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { bindingAvailable } from '../__tests__/_binding-probe';
import {
  hasPendingStorageShutdownTasks,
  runStorageShutdownTasks,
} from './shutdown-tasks';

describe.skipIf(!bindingAvailable)('storage shutdown tasks', () => {
  it('spawns work only for the two shutdown-owned durable phases', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE storage_maintenance_state (
          task TEXT PRIMARY KEY,
          phase TEXT NOT NULL,
          cursor INTEGER NOT NULL,
          upper_bound INTEGER NOT NULL,
          batch_size INTEGER NOT NULL,
          last_error TEXT,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO storage_maintenance_state VALUES
          ('event-search-v1', 'awaiting-restart', 0, 0, 1, NULL, 0),
          ('file-snapshot-blobs-v1', 'clear', 0, 0, 1, NULL, 0);
      `);
      expect(hasPendingStorageShutdownTasks(db)).toBe(false);
      db.prepare(
        `UPDATE storage_maintenance_state SET phase = 'retire-on-shutdown'
          WHERE task = 'event-search-v1'`,
      ).run();
      expect(hasPendingStorageShutdownTasks(db)).toBe(true);
      db.prepare(
        `UPDATE storage_maintenance_state SET phase = 'complete'
          WHERE task = 'event-search-v1'`,
      ).run();
      db.prepare(
        `UPDATE storage_maintenance_state SET phase = 'indexes-on-shutdown'
          WHERE task = 'file-snapshot-blobs-v1'`,
      ).run();
      expect(hasPendingStorageShutdownTasks(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('runs the two tasks independently and bounds one failure', () => {
    const db = new Database(':memory:');
    try {
      const prepareSnapshotIndexes = vi.fn(() => {
        throw new Error('snapshot index boom\nwith detail');
      });
      const retireEventSearch = vi.fn(() => ({
        retired: true,
        durationMs: 21,
        freedPages: 34,
      }));

      const results = runStorageShutdownTasks(db, {
        prepareSnapshotIndexes,
        retireEventSearch,
      });

      expect(results.snapshotIndexes).toEqual({
        ok: false,
        error: 'snapshot index boom with detail',
      });
      expect(results.eventSearchRetirement).toEqual({
        ok: true,
        result: { retired: true, durationMs: 21, freedPages: 34 },
      });
      expect(prepareSnapshotIndexes).toHaveBeenCalledOnce();
      expect(retireEventSearch).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
