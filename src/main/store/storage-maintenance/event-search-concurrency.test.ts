import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bindingAvailable } from '../__tests__/_binding-probe';
import { MIGRATIONS } from '../migrations';
import { runEventSearchSlice } from './event-search';
import { readMaintenanceState } from './state';

interface Fixture {
  maintenance: Database.Database;
  ingress: Database.Database;
  eventId: number;
  close(): void;
}

function openConnection(path: string): Database.Database {
  const db = new Database(path, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  return db;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-event-backfill-race-'));
  const path = join(root, 'agent-deck.db');
  const maintenance = new Database(path);
  maintenance.pragma('journal_mode = WAL');
  maintenance.pragma('foreign_keys = ON');
  maintenance.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > 40) break;
    maintenance.exec(migration.sql);
  }
  maintenance.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES ('s1', 'codex-cli', '/repo', 's1', 'sdk', 'active', 'idle', 1, 1)`,
  ).run();
  const eventId = Number(maintenance.prepare(
    `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
     VALUES ('s1', 'message', ?, 10, NULL)`,
  ).run(JSON.stringify({ text: 'stale legacy marker' })).lastInsertRowid);
  maintenance.exec(MIGRATIONS.find((migration) => migration.version === 41)!.sql);
  const ingress = openConnection(path);

  return {
    maintenance,
    ingress,
    eventId,
    close(): void {
      ingress.close();
      maintenance.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function matchingRowids(db: Database.Database, marker: string): number[] {
  return db.prepare(
    `SELECT rowid FROM event_search_fts_v1
      WHERE event_search_fts_v1 MATCH ? ORDER BY rowid`,
  ).pluck().all(`"${marker}"`) as number[];
}

describe.skipIf(!bindingAvailable)('event-search WAL backfill concurrency', () => {
  it('re-projects an event updated by ingress after preselection', () => {
    const fixture = createFixture();
    try {
      let barrierCalls = 0;
      const slice = runEventSearchSlice(fixture.maintenance, {
        afterBackfillPreselect(eventIds) {
          barrierCalls += 1;
          expect(eventIds).toEqual([fixture.eventId]);
          fixture.ingress.prepare(
            `UPDATE events SET payload_json = ?, ts = 11 WHERE id = ?`,
          ).run(JSON.stringify({ text: 'fresh concurrent marker' }), fixture.eventId);
        },
      });

      expect(barrierCalls).toBe(1);
      expect(slice).toMatchObject({ phase: 'backfill', processed: 1 });
      expect(matchingRowids(fixture.maintenance, 'fresh')).toEqual([fixture.eventId]);
      expect(matchingRowids(fixture.maintenance, 'stale')).toEqual([]);
      expect(readMaintenanceState(fixture.maintenance, 'event-search-v1')?.cursor)
        .toBe(fixture.eventId);
    } finally {
      fixture.close();
    }
  });

  it('does not resurrect an event deleted by ingress after preselection', () => {
    const fixture = createFixture();
    try {
      const slice = runEventSearchSlice(fixture.maintenance, {
        afterBackfillPreselect(eventIds) {
          expect(eventIds).toEqual([fixture.eventId]);
          fixture.ingress.prepare('DELETE FROM events WHERE id = ?').run(fixture.eventId);
        },
      });

      expect(slice).toMatchObject({ phase: 'backfill', processed: 1 });
      expect(fixture.maintenance.prepare(
        'SELECT COUNT(*) FROM events WHERE id = ?',
      ).pluck().get(fixture.eventId)).toBe(0);
      expect(fixture.maintenance.prepare(
        'SELECT COUNT(*) FROM event_search_fts_v1 WHERE rowid = ?',
      ).pluck().get(fixture.eventId)).toBe(0);
      expect(readMaintenanceState(fixture.maintenance, 'event-search-v1')?.cursor)
        .toBe(fixture.eventId);
    } finally {
      fixture.close();
    }
  });

  it('rolls back candidate data when the atomic cursor update fails', () => {
    const fixture = createFixture();
    try {
      fixture.maintenance.exec(`
        CREATE TRIGGER fail_event_search_cursor
        BEFORE UPDATE OF cursor ON storage_maintenance_state
        WHEN OLD.task = 'event-search-v1'
        BEGIN
          SELECT RAISE(ABORT, 'cursor barrier');
        END;
      `);

      expect(() => runEventSearchSlice(fixture.maintenance)).toThrow(/cursor barrier/);
      expect(matchingRowids(fixture.maintenance, 'stale')).toEqual([]);
      expect(readMaintenanceState(fixture.maintenance, 'event-search-v1')?.cursor).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
