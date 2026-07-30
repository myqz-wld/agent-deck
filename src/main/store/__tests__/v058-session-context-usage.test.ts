import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import { updateContextUsageWithDb } from '../session-repo/context-usage';
import { renameWithDb } from '../session-repo/rename';
import { rowToRecord, type Row } from '../session-repo/types';
import { bindingAvailable } from './_binding-probe';

function migrateThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', 'active', 'idle', 1, 1)`,
  ).run(id, id);
}

function record(db: Database.Database, id: string) {
  return rowToRecord(
    db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row,
  );
}

describe.skipIf(!bindingAvailable)('v058 session context usage', () => {
  it('adds a nullable snapshot, merges partial updates, and resets used count on compaction', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 57);
      insertSession(db, 'context-session');
      const migration = MIGRATIONS.find(({ version }) => version === 58);
      expect(migration).toMatchObject({
        version: 58,
        name: 'sessions_context_usage',
        execution: 'startup',
      });
      db.exec(migration!.sql);
      expect(record(db, 'context-session').contextUsage).toBeNull();

      updateContextUsageWithDb(
        db,
        'context-session',
        { usedTokens: 80_000, windowTokens: 200_000 },
        20,
      );
      expect(record(db, 'context-session').contextUsage).toEqual({
        usedTokens: 80_000,
        windowTokens: 200_000,
        updatedAt: 20,
      });

      updateContextUsageWithDb(db, 'context-session', { usedTokens: 99_000 }, 19);
      expect(record(db, 'context-session').contextUsage?.usedTokens).toBe(80_000);

      updateContextUsageWithDb(db, 'context-session', { usedTokens: null }, 21);
      expect(record(db, 'context-session').contextUsage).toEqual({
        usedTokens: null,
        windowTokens: 200_000,
        updatedAt: 21,
      });
    } finally {
      db.close();
    }
  });

  it('keeps the latest context snapshot across both session rename paths', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 58);
      insertSession(db, 'missing-source');
      updateContextUsageWithDb(
        db,
        'missing-source',
        { usedTokens: 12_000, windowTokens: 128_000 },
        30,
      );
      renameWithDb(db, 'missing-source', 'missing-target');
      expect(record(db, 'missing-target').contextUsage?.usedTokens).toBe(12_000);

      insertSession(db, 'existing-source');
      insertSession(db, 'existing-target');
      updateContextUsageWithDb(
        db,
        'existing-source',
        { usedTokens: 34_000, windowTokens: 272_000 },
        40,
      );
      updateContextUsageWithDb(
        db,
        'existing-target',
        { usedTokens: 1, windowTokens: 2 },
        41,
      );
      renameWithDb(db, 'existing-source', 'existing-target');
      expect(record(db, 'existing-target').contextUsage).toEqual({
        usedTokens: 34_000,
        windowTokens: 272_000,
        updatedAt: 40,
      });
    } finally {
      db.close();
    }
  });
});
