import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createTokenUsageRepo } from '../token-usage-repo';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

function migrateThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
}

describe.skipIf(!bindingAvailable)('v052 token usage metric-scope repair', () => {
  it('restores non-Grok additive aggregates without weakening strict provider totals', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 51);
      const localNoon = new Date(2026, 6, 27, 12, 0, 0).getTime();
      const insert = db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            total_tokens, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_creation_tokens, metric_scope, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'codex-1',
        'codex-cli',
        null,
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        null,
        100,
        20,
        5,
        80,
        null,
        63,
        localNoon,
      );
      insert.run(
        'codex-1',
        'codex-cli',
        null,
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        null,
        40,
        null,
        null,
        32,
        null,
        63,
        localNoon + 1,
      );
      insert.run(
        'claude-1',
        'claude-code',
        'empty-legacy',
        '<synthetic>',
        '<synthetic>',
        null,
        null,
        null,
        null,
        null,
        null,
        63,
        localNoon + 2,
      );
      insert.run(
        'grok-1',
        'grok-build',
        'partial-grok',
        'grok-4.5',
        'grok-4.5',
        77,
        null,
        null,
        null,
        null,
        null,
        63,
        localNoon + 3,
      );
      insert.run(
        'claude-1',
        'claude-code',
        'reasoning-only',
        'claude-unattributed-reasoning',
        'claude-unattributed-reasoning',
        null,
        null,
        null,
        7,
        null,
        null,
        8,
        localNoon + 4,
      );

      const migration = MIGRATIONS.find((candidate) => candidate.version === 52);
      expect(migration).toMatchObject({
        version: 52,
        name: 'token_usage_metric_scope_repair',
      });
      db.exec(migration!.sql);

      expect(
        db.prepare(
          `SELECT agent_id, message_id, metric_scope
             FROM token_usage
            ORDER BY id`,
        ).all(),
      ).toEqual([
        { agent_id: 'codex-cli', message_id: null, metric_scope: 31 },
        { agent_id: 'codex-cli', message_id: null, metric_scope: 19 },
        { agent_id: 'claude-code', message_id: 'empty-legacy', metric_scope: 1 },
        { agent_id: 'grok-build', message_id: 'partial-grok', metric_scope: 63 },
        { agent_id: 'claude-code', message_id: 'reasoning-only', metric_scope: 8 },
      ]);

      const daily = createTokenUsageRepo(db).dailyByModel();
      expect(daily.find((row) => row.bucketKey === 'gpt-5.6-sol')).toMatchObject({
        providerTotalTokens: null,
        inputTotalTokens: 140,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 112,
        cacheCreationTokens: null,
      });
    } finally {
      db.close();
    }
  });
});
