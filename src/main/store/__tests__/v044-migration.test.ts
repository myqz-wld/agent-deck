import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
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

describe.skipIf(!bindingAvailable)('v044 hidden History sessions', () => {
  it('is the next migration and keeps existing/new sessions visible by default', () => {
    const v043Index = MIGRATIONS.findIndex((migration) => migration.version === 43);
    const v044Index = MIGRATIONS.findIndex((migration) => migration.version === 44);
    expect(v044Index).toBe(v043Index + 1);
    expect(MIGRATIONS[v044Index]).toMatchObject({
      version: 44,
      name: 'sessions_hidden_from_history',
    });

    const db = makeDbThrough(43);
    try {
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('existing', 'codex-cli', '/repo', 'Existing', 'sdk', 'closed', 'idle', 1, 1)`,
      ).run();
      db.exec(MIGRATIONS[v044Index]!.sql);
      expect(db.prepare(
        `SELECT hidden_from_history FROM sessions WHERE id = 'existing'`,
      ).pluck().get()).toBe(0);

      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('new', 'codex-cli', '/repo', 'New', 'sdk', 'closed', 'idle', 1, 1)`,
      ).run();
      expect(db.prepare(
        `SELECT hidden_from_history FROM sessions WHERE id = 'new'`,
      ).pluck().get()).toBe(0);
      expect(() => db.prepare(
        `UPDATE sessions SET hidden_from_history = 2 WHERE id = 'new'`,
      ).run()).toThrow();
    } finally {
      db.close();
    }
  });
});
