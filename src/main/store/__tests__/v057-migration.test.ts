import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

function migrateThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
}

describe.skipIf(!bindingAvailable)('v057 token usage metric-scope repair', () => {
  it('removes only absent optional metric bits from non-Grok rows', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 56);
      const insert = db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            total_tokens, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_creation_tokens, metric_scope, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'claude-1', 'claude-code', 'partial-claude', 'sonnet', 'sonnet',
        null, 12, 4, null, 0, 0, 63, 1,
      );
      insert.run(
        'codex-1', 'codex-cli', 'explicit-zero', 'gpt', 'gpt',
        null, 20, 8, 3, 100, 0, 63, 2,
      );
      insert.run(
        'claude-1', 'claude-code', 'reasoning-only', 'reasoning', 'reasoning',
        null, null, null, 7, null, null, 8, 3,
      );
      insert.run(
        'grok-1', 'grok-build', 'partial-grok', 'grok', 'grok',
        100, 80, 20, 5, 10, null, 63, 4,
      );

      const migration = MIGRATIONS.find(({ version }) => version === 57);
      expect(migration).toMatchObject({
        version: 57,
        name: 'token_usage_metric_scope_repair_v2',
      });
      db.exec(migration!.sql);

      expect(db.prepare(
        `SELECT agent_id, message_id, metric_scope
           FROM token_usage
          ORDER BY id`,
      ).all()).toEqual([
        { agent_id: 'claude-code', message_id: 'partial-claude', metric_scope: 55 },
        { agent_id: 'codex-cli', message_id: 'explicit-zero', metric_scope: 63 },
        { agent_id: 'claude-code', message_id: 'reasoning-only', metric_scope: 8 },
        { agent_id: 'grok-build', message_id: 'partial-grok', metric_scope: 63 },
      ]);

      expect(db.prepare(
        `SELECT source_revision, full_rebuild_required
           FROM token_usage_daily_state
          WHERE singleton = 1`,
      ).get()).toMatchObject({ source_revision: 5, full_rebuild_required: 1 });
    } finally {
      db.close();
    }
  });
});
