/**
 * v036 migration test — repair GPT token_usage.model_bucket values without widening scope.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

function makePreV036Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version >= 36) break;
    db.exec(migration.sql);
  }
  return db;
}

function migrationV036(): string {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 36);
  expect(migration).toBeDefined();
  return migration!.sql;
}

function insertUsage(
  db: Database.Database,
  modelRaw: string,
  modelBucket: string,
  agentId = 'codex-cli',
): void {
  db.prepare(
    `INSERT INTO token_usage
       (session_id, agent_id, message_id, model_raw, model_bucket,
        input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_creation_tokens, ts)
     VALUES ('session-1', ?, NULL, ?, ?, 11, 22, 3, 4, 5, 1000)`,
  ).run(agentId, modelRaw, modelBucket);
}

function modelRows(db: Database.Database): { modelRaw: string; modelBucket: string }[] {
  return db
    .prepare(
      `SELECT model_raw AS modelRaw, model_bucket AS modelBucket
       FROM token_usage ORDER BY id`,
    )
    .all() as { modelRaw: string; modelBucket: string }[];
}

describe.skipIf(!bindingAvailable)('v036 migration / GPT token usage model buckets', () => {
  it('restores official and custom GPT semantic suffixes from model_raw', () => {
    const db = makePreV036Db();
    try {
      const cases = [
        ['gpt-5.6-sol', 'gpt-5.6', 'gpt-5.6-sol'],
        ['gpt-5.6-terra', 'gpt-5.6', 'gpt-5.6-terra'],
        ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.6-luna'],
        ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-mini'],
        ['gpt-5.3-codex-spark', 'gpt-5.3', 'gpt-5.3-codex-spark'],
        ['gpt-5.6-provider-preview', 'gpt-5.6', 'gpt-5.6-provider-preview'],
        ['gpt-5.6-thinking-preview', 'gpt-5.6', 'gpt-5.6-thinking-preview'],
        ['gpt-5.6-context[1m]-preview', 'gpt-5.6', 'gpt-5.6-context[1m]-preview'],
        ['gpt-5.6-high-throughput', 'gpt-5.6', 'gpt-5.6-high-throughput'],
        ['gpt-5.6-sol-thinking-max[1m]', 'gpt-5.6', 'gpt-5.6-sol'],
        ['  GPT-5.6-SOL-ULTRA  ', 'gpt-5.6', 'gpt-5.6-sol'],
      ] as const;
      for (const [raw, oldBucket] of cases) insertUsage(db, raw, oldBucket);

      db.exec(migrationV036());

      expect(modelRows(db)).toEqual(
        cases.map(([modelRaw, , modelBucket]) => ({ modelRaw, modelBucket })),
      );
    } finally {
      db.close();
    }
  });

  it('preserves bare GPT spelling compatibility and leaves Claude/non-GPT rows untouched', () => {
    const db = makePreV036Db();
    try {
      insertUsage(db, 'gpt-5.6', 'gpt-5.6');
      insertUsage(db, 'gpt-5-6', 'gpt-5.6');
      insertUsage(db, 'gpt-5.5-thinking-max[1m]', 'gpt-5.5');
      insertUsage(db, 'claude-opus-4-8-preview', 'opus-4.8', 'claude-code');
      insertUsage(db, 'claude-haiku-4-5-20251001', 'haiku-4.5', 'claude-code');
      insertUsage(db, 'deepseek-v4-pro[1m]', 'deepseek-v4-pro', 'deepseek-claude-code');

      db.exec(migrationV036());

      expect(modelRows(db)).toEqual([
        { modelRaw: 'gpt-5.6', modelBucket: 'gpt-5.6' },
        { modelRaw: 'gpt-5-6', modelBucket: 'gpt-5.6' },
        { modelRaw: 'gpt-5.5-thinking-max[1m]', modelBucket: 'gpt-5.5' },
        { modelRaw: 'claude-opus-4-8-preview', modelBucket: 'opus-4.8' },
        { modelRaw: 'claude-haiku-4-5-20251001', modelBucket: 'haiku-4.5' },
        { modelRaw: 'deepseek-v4-pro[1m]', modelBucket: 'deepseek-v4-pro' },
      ]);
      expect(
        db
          .prepare(
            `SELECT input_tokens, output_tokens, reasoning_tokens,
                    cache_read_tokens, cache_creation_tokens, ts
             FROM token_usage WHERE model_raw = 'gpt-5-6'`,
          )
          .get(),
      ).toEqual({
        input_tokens: 11,
        output_tokens: 22,
        reasoning_tokens: 3,
        cache_read_tokens: 4,
        cache_creation_tokens: 5,
        ts: 1000,
      });
    } finally {
      db.close();
    }
  });

  it('is idempotent', () => {
    const db = makePreV036Db();
    try {
      insertUsage(db, 'gpt-5.6-sol-thinking-max[1m]', 'gpt-5.6');
      const sql = migrationV036();
      db.exec(sql);
      const once = db.prepare('SELECT * FROM token_usage').all();
      db.exec(sql);
      expect(db.prepare('SELECT * FROM token_usage').all()).toEqual(once);
    } finally {
      db.close();
    }
  });
});
