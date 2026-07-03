/**
 * v035 migration test — token_usage.reasoning_tokens.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

type SchemaVersion = 'pre-v035' | 'post-v035';

function makeDbAt(version: SchemaVersion): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) {
    if (version === 'pre-v035' && migration.version >= 35) break;
    db.exec(migration.sql);
  }
  return db;
}

describe.skipIf(!bindingAvailable)('v035 migration / token_usage reasoning tokens', () => {
  it('post-v035 schema has reasoning_tokens with default zero', () => {
    const db = makeDbAt('post-v035');
    try {
      db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ts)
         VALUES ('s1', 'codex-cli', NULL, 'gpt-5.5', 'gpt-5.5', 1, 2, 3, 0, 1000)`,
      ).run();

      const row = db.prepare(`SELECT output_tokens, reasoning_tokens FROM token_usage`).get() as {
        output_tokens: number;
        reasoning_tokens: number;
      };
      expect(row).toEqual({ output_tokens: 2, reasoning_tokens: 0 });
    } finally {
      db.close();
    }
  });

  it('v034 to v035 upgrade keeps old token rows and backfills reasoning_tokens to zero', () => {
    const db = makeDbAt('pre-v035');
    try {
      db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ts)
         VALUES ('s1', 'codex-cli', NULL, 'gpt-5.5', 'gpt-5.5', 10, 20, 5, 0, 1000)`,
      ).run();

      const v035 = MIGRATIONS.find((migration) => migration.version === 35);
      expect(v035).toBeDefined();
      db.exec(v035!.sql);

      const row = db.prepare(`SELECT input_tokens, output_tokens, reasoning_tokens FROM token_usage`).get() as {
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens: number;
      };
      expect(row).toEqual({ input_tokens: 10, output_tokens: 20, reasoning_tokens: 0 });
    } finally {
      db.close();
    }
  });
});
