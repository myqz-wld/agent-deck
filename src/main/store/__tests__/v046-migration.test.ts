import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

describe.skipIf(!bindingAvailable)('v046 session runtime provider', () => {
  it('adds runtime_provider and rewrites legacy Deepseek sessions', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.version > 45) break;
        db.exec(migration.sql);
      }
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES
           ('deepseek', 'deepseek-claude-code', '/repo', 'Legacy', 'sdk', 'dormant', 'idle', 1, 1),
           ('claude', 'claude-code', '/repo', 'Claude', 'sdk', 'active', 'idle', 1, 1)`,
      ).run();

      const migration = MIGRATIONS.find((candidate) => candidate.version === 46);
      expect(migration).toMatchObject({
        version: 46,
        name: 'sessions_runtime_provider',
      });
      db.exec(migration!.sql);

      expect(
        db.prepare(
          `SELECT agent_id, runtime_provider FROM sessions WHERE id = 'deepseek'`,
        ).get(),
      ).toEqual({
        agent_id: 'claude-code',
        runtime_provider: 'deepseek',
      });
      expect(
        db.prepare(
          `SELECT agent_id, runtime_provider FROM sessions WHERE id = 'claude'`,
        ).get(),
      ).toEqual({
        agent_id: 'claude-code',
        runtime_provider: null,
      });
    } finally {
      db.close();
    }
  });
});
