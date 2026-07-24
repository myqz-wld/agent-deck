import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

describe.skipIf(!bindingAvailable)('v045 adapter session mode', () => {
  it('adds a nullable, constrained session_mode column after v044', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.version > 44) break;
        db.exec(migration.sql);
      }
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('existing', 'grok-build', '/repo', 'Existing', 'sdk', 'active', 'idle', 1, 1)`,
      ).run();

      const migration = MIGRATIONS.find((candidate) => candidate.version === 45);
      expect(migration).toMatchObject({
        version: 45,
        name: 'sessions_adapter_mode',
      });
      db.exec(migration!.sql);
      expect(db.prepare(
        `SELECT session_mode FROM sessions WHERE id = 'existing'`,
      ).pluck().get()).toBeNull();
      expect(() => db.prepare(
        `UPDATE sessions SET session_mode = 'ask' WHERE id = 'existing'`,
      ).run()).not.toThrow();
      expect(() => db.prepare(
        `UPDATE sessions SET session_mode = 'bypassPermissions' WHERE id = 'existing'`,
      ).run()).toThrow();
    } finally {
      db.close();
    }
  });
});
