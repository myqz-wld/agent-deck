import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { rowToRecord, type Row } from '../session-repo/types';
import { bindingAvailable } from './_binding-probe';

function migrateThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
}

describe.skipIf(!bindingAvailable)('v053 Grok sandbox migration', () => {
  it('adds a nullable profile without changing existing Grok behavior', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 52);
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('grok-old', 'grok-build', '/repo', 'old', 'sdk',
                 'dormant', 'idle', 1, 1)`,
      ).run();

      const migration = MIGRATIONS.find((candidate) => candidate.version === 53);
      expect(migration).toMatchObject({
        version: 53,
        name: 'sessions_grok_sandbox',
      });
      db.exec(migration!.sql);

      const column = (
        db.prepare(`PRAGMA table_info('sessions')`).all() as Array<{
          name: string;
          notnull: number;
        }>
      ).find((candidate) => candidate.name === 'grok_sandbox');
      expect(column).toMatchObject({ name: 'grok_sandbox', notnull: 0 });
      const oldRow = db.prepare(
        `SELECT * FROM sessions WHERE id = 'grok-old'`,
      ).get() as Row;
      expect(rowToRecord(oldRow).grokSandbox).toBeNull();

      db.prepare(
        `UPDATE sessions SET grok_sandbox = 'project-locked' WHERE id = 'grok-old'`,
      ).run();
      const updated = db.prepare(
        `SELECT * FROM sessions WHERE id = 'grok-old'`,
      ).get() as Row;
      expect(rowToRecord(updated).grokSandbox).toBe('project-locked');
    } finally {
      db.close();
    }
  });
});
