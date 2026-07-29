import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';
import { createTokenUsageRepo } from '../token-usage-repo';

function migrateThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
}

function state(db: Database.Database): Record<string, unknown> {
  return db.prepare(
    `SELECT source_revision, projection_revision, timezone_fingerprint,
            full_rebuild_required
       FROM token_usage_daily_state
      WHERE singleton = 1`,
  ).get() as Record<string, unknown>;
}

function dirtyDays(db: Database.Database): string[] {
  return (
    db.prepare(
      `SELECT day FROM token_usage_daily_dirty_days ORDER BY day`,
    ).all() as Array<{ day: string }>
  ).map(({ day }) => day);
}

describe.skipIf(!bindingAvailable)('v055 token usage daily rollup', () => {
  it('is a startup O(schema) migration that preserves the raw ledger indexes', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 54);
      const insert = db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            total_tokens, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_creation_tokens, metric_scope, ts)
         VALUES ('s', 'codex-cli', NULL, 'gpt-5.6-sol', 'gpt-5.6-sol',
                 NULL, 10, 4, 1, 2, NULL, 31, ?)`,
      );
      insert.run(new Date(2026, 5, 1, 12).getTime());
      const indexesBefore = (
        db.prepare(
          `SELECT name, sql FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'token_usage'
            ORDER BY name`,
        ).all()
      );

      const migration = MIGRATIONS.find(({ version }) => version === 55);
      expect(migration).toMatchObject({
        version: 55,
        name: 'token_usage_daily_rollup',
        execution: 'startup',
      });
      db.exec(migration!.sql);

      expect(state(db)).toEqual({
        source_revision: 0,
        projection_revision: -1,
        timezone_fingerprint: null,
        full_rebuild_required: 1,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM token_usage_daily_rollup').get())
        .toEqual({ count: 0 });
      expect(dirtyDays(db)).toEqual([]);
      expect(
        db.prepare(
          `SELECT name, sql FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'token_usage'
            ORDER BY name`,
        ).all(),
      ).toEqual(indexesBefore);
    } finally {
      db.close();
    }
  });

  it('tracks INSERT, meaningful UPDATE, OLD+NEW local days, and DELETE atomically', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 55);
      const first = new Date(2026, 5, 1, 12).getTime();
      const second = new Date(2026, 5, 2, 12).getTime();
      db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            total_tokens, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_creation_tokens, metric_scope, ts)
         VALUES ('s', 'claude-code', 'm', 'claude-opus-4-8', 'opus-4.8',
                 NULL, 10, 4, 1, 2, 3, 63, ?)`,
      ).run(first);
      expect(state(db).source_revision).toBe(1);
      expect(dirtyDays(db)).toEqual(['2026-06-01']);

      db.prepare(
        `UPDATE token_usage
            SET model_bucket = 'sonnet-4.5', ts = ?
          WHERE message_id = 'm'`,
      ).run(second);
      expect(state(db).source_revision).toBe(2);
      expect(dirtyDays(db)).toEqual(['2026-06-01', '2026-06-02']);

      db.prepare(`UPDATE token_usage SET output_tokens = output_tokens`).run();
      expect(state(db).source_revision).toBe(2);

      db.prepare(`DELETE FROM token_usage WHERE message_id = 'm'`).run();
      expect(state(db).source_revision).toBe(3);
      expect(dirtyDays(db)).toEqual(['2026-06-01', '2026-06-02']);
    } finally {
      db.close();
    }
  });

  it('keeps a freshly migrated empty database immediately queryable', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 55);
      expect(createTokenUsageRepo(db).dailyByModel()).toEqual([]);
      expect(state(db)).toMatchObject({
        source_revision: 0,
        projection_revision: 0,
        full_rebuild_required: 0,
      });
    } finally {
      db.close();
    }
  });
});
