import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { renameWithDb } from '../session-repo/rename';
import { rowToRecord, type Row } from '../session-repo/types';
import { bindingAvailable } from './_binding-probe';

function migrateThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.sql);
  }
}

function migration(version: number, name: string): string {
  const found = MIGRATIONS.find((candidate) => candidate.version === version);
  expect(found).toMatchObject({ version, name });
  return found!.sql;
}

describe.skipIf(!bindingAvailable)('v049-v051 adapter fidelity migrations', () => {
  it('adds durable Codex approval and Grok cumulative usage state to sessions', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 48);
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('session-1', 'codex-cli', '/repo', 'review', 'sdk',
                 'dormant', 'idle', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
            agent_profile_name)
         VALUES ('named-reviewer', 'codex-cli', '/repo', 'reviewer', 'sdk',
                 'dormant', 'idle', 1, 1, 'reviewer-codex')`,
      ).run();
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
            network_access_enabled, additional_directories)
         VALUES ('legacy-reviewer', 'codex-cli', '/repo', 'legacy reviewer', 'sdk',
                 'dormant', 'idle', 1, 1, 1, ?)`,
      ).run(JSON.stringify(['~/.claude', '~/.codex', '/tmp']));
      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
            network_access_enabled, additional_directories)
         VALUES ('ordinary', 'codex-cli', '/repo', 'ordinary', 'sdk',
                 'dormant', 'idle', 1, 1, 1, ?)`,
      ).run(JSON.stringify(['/tmp']));

      db.exec(migration(49, 'sessions_codex_approval_policy'));
      db.exec(migration(50, 'sessions_grok_usage_watermark'));

      const columns = db.prepare(`PRAGMA table_info('sessions')`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'codex_approval_policy', notnull: 0 }),
          expect.objectContaining({ name: 'grok_usage_watermark', notnull: 0 }),
        ]),
      );
      expect(
        db.prepare(
          `SELECT codex_approval_policy AS approval,
                  grok_usage_watermark AS watermark
             FROM sessions WHERE id = 'session-1'`,
        ).get(),
      ).toEqual({ approval: null, watermark: null });
      expect(
        db.prepare(
          `SELECT id, codex_approval_policy AS approval
             FROM sessions
            WHERE id IN ('named-reviewer', 'legacy-reviewer', 'ordinary')
            ORDER BY id`,
        ).all(),
      ).toEqual([
        { id: 'legacy-reviewer', approval: 'never' },
        { id: 'named-reviewer', approval: 'never' },
        { id: 'ordinary', approval: null },
      ]);

      const watermark = {
        totalTokens: 120,
        inputTokens: 90,
        outputTokens: 30,
        thoughtTokens: 6,
        cachedReadTokens: 20,
        cachedWriteTokens: null,
      };
      db.prepare(
        `UPDATE sessions
            SET codex_approval_policy = 'never',
                grok_usage_watermark = ?
          WHERE id = 'session-1'`,
      ).run(JSON.stringify(watermark));
      const row = db.prepare(
        `SELECT * FROM sessions WHERE id = 'session-1'`,
      ).get() as Row;
      expect(rowToRecord(row)).toMatchObject({
        codexApprovalPolicy: 'never',
        grokUsageWatermark: watermark,
      });

      db.prepare(
        `INSERT INTO sessions
           (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
         VALUES ('session-2', 'codex-cli', '/repo', 'target', 'sdk',
                 'active', 'idle', 2, 2)`,
      ).run();
      // renameWithDb follows the current latest-schema contract. Add the independent nullable
      // sessions columns introduced after this historical migration range before exercising rename.
      db.exec(migration(53, 'sessions_grok_sandbox'));
      db.exec(migration(58, 'sessions_context_usage'));
      renameWithDb(db, 'session-1', 'session-2');
      const renamed = db.prepare(
        `SELECT * FROM sessions WHERE id = 'session-2'`,
      ).get() as Row;
      expect(rowToRecord(renamed)).toMatchObject({
        codexApprovalPolicy: 'never',
        grokUsageWatermark: watermark,
      });
    } finally {
      db.close();
    }
  });

  it('rebuilds token_usage with nullable metrics, exact totals, and preserved indexes', () => {
    const db = new Database(':memory:');
    try {
      migrateThrough(db, 50);
      db.prepare(
        `INSERT INTO token_usage
           (id, session_id, agent_id, message_id, model_raw, model_bucket,
            input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_creation_tokens, ts)
         VALUES (7, 'session-1', 'grok-build', 'prompt-1', 'grok-4.5',
                 'grok-4.5', 10, 4, 2, 3, 1, 1000)`,
      ).run();
      for (const [id, agentId] of [
        [8, 'claude-code'],
        [9, 'codex-cli'],
        [10, 'grok-build'],
      ] as const) {
        db.prepare(
          `INSERT INTO token_usage
             (id, session_id, agent_id, message_id, model_raw, model_bucket,
              input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_creation_tokens, ts)
           VALUES (?, 'session-zero', ?, ?, 'provider-model',
                   'provider-model', 0, 0, 0, 0, 0, 1001)`,
        ).run(id, agentId, `zero-${agentId}`);
      }

      db.exec(migration(51, 'token_usage_presence'));

      const columns = db.prepare(`PRAGMA table_info('token_usage')`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      for (const name of [
        'total_tokens',
        'input_tokens',
        'output_tokens',
        'reasoning_tokens',
        'cache_read_tokens',
        'cache_creation_tokens',
      ]) {
        expect(columns.find((column) => column.name === name)).toMatchObject({
          name,
          notnull: 0,
        });
      }
      expect(columns.find((column) => column.name === 'metric_scope')).toMatchObject({
        name: 'metric_scope',
        notnull: 1,
      });
      expect(
        db.prepare(
          `SELECT id, total_tokens, input_tokens, output_tokens, reasoning_tokens,
                  cache_read_tokens, cache_creation_tokens, metric_scope
             FROM token_usage`,
        ).get(),
      ).toEqual({
        id: 7,
        total_tokens: null,
        input_tokens: 10,
        output_tokens: 4,
        reasoning_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 1,
        metric_scope: 63,
      });
      expect(
        db.prepare(
          `SELECT agent_id, input_tokens, output_tokens, reasoning_tokens,
                  cache_read_tokens, cache_creation_tokens
             FROM token_usage
            WHERE session_id = 'session-zero'
            ORDER BY id`,
        ).all(),
      ).toEqual([
        {
          agent_id: 'claude-code',
          input_tokens: null,
          output_tokens: null,
          reasoning_tokens: null,
          cache_read_tokens: null,
          cache_creation_tokens: null,
        },
        {
          agent_id: 'codex-cli',
          input_tokens: null,
          output_tokens: null,
          reasoning_tokens: null,
          cache_read_tokens: null,
          cache_creation_tokens: null,
        },
        {
          agent_id: 'grok-build',
          input_tokens: null,
          output_tokens: null,
          reasoning_tokens: null,
          cache_read_tokens: null,
          cache_creation_tokens: null,
        },
      ]);

      db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            total_tokens, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_creation_tokens, ts)
         VALUES ('session-2', 'grok-build', 'prompt-total', 'grok-4.5',
                 'grok-4.5', 77, NULL, NULL, NULL, NULL, NULL, 1001)`,
      ).run();
      expect(
        db.prepare(
          `SELECT total_tokens, input_tokens, output_tokens
             FROM token_usage WHERE message_id = 'prompt-total'`,
        ).get(),
      ).toEqual({ total_tokens: 77, input_tokens: null, output_tokens: null });

      const indexes = db.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'token_usage'`,
      ).all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'uq_token_usage_message_id',
          'idx_token_usage_ts',
          'idx_token_usage_bucket_ts',
        ]),
      );
    } finally {
      db.close();
    }
  });
});
