import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

describe.skipIf(!bindingAvailable)('v047 session Agent runtime profile', () => {
  it('adds nullable profile columns and constrains the discovery source', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.version > 46) break;
        db.exec(migration.sql);
      }
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES
           ('existing', 'claude-code', '/repo', 'Existing', 'sdk', 'dormant', 'idle', 1, 1)`,
      ).run();

      const migration = MIGRATIONS.find((candidate) => candidate.version === 47);
      expect(migration).toMatchObject({
        version: 47,
        name: 'sessions_agent_runtime_profile',
      });
      db.exec(migration!.sql);

      expect(
        db.prepare(
          `SELECT agent_profile_name, agent_profile_source, agent_plugin_dir
           FROM sessions WHERE id = 'existing'`,
        ).get(),
      ).toEqual({
        agent_profile_name: null,
        agent_profile_source: null,
        agent_plugin_dir: null,
      });
      expect(() =>
        db.prepare(
          `UPDATE sessions SET agent_profile_source = 'unknown' WHERE id = 'existing'`,
        ).run(),
      ).toThrow();
      expect(() =>
        db.prepare(
          `UPDATE sessions
           SET agent_profile_name = 'reviewer-claude',
               agent_profile_source = 'plugin',
               agent_plugin_dir = '/plugins/reviewer-claude'
           WHERE id = 'existing'`,
        ).run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
