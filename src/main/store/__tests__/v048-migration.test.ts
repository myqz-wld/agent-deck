import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../migrations';
import { bindingAvailable } from './_binding-probe';

describe.skipIf(!bindingAvailable)('v048 Codex output token totals', () => {
  it('subtracts only an exact recorded Codex reasoning subset', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.version > 47) break;
        db.exec(migration.sql);
      }
      const insert = db.prepare(
        `INSERT INTO token_usage
           (session_id, agent_id, message_id, model_raw, model_bucket,
            input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_creation_tokens, ts)
         VALUES (?, ?, NULL, ?, ?, 10, ?, ?, 0, 0, 1)`,
      );
      insert.run('codex-exact', 'codex-cli', 'gpt-5.6-sol', 'gpt-5.6-sol', 25, 7);
      insert.run('codex-unknown', 'codex-cli', 'gpt-5.6-sol', 'gpt-5.6-sol', 25, 0);
      insert.run('claude', 'claude-code', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 25, 7);

      const migration = MIGRATIONS.find((candidate) => candidate.version === 48);
      expect(migration).toMatchObject({
        version: 48,
        name: 'codex_output_token_totals',
      });
      db.exec(migration!.sql);

      expect(db.prepare(
        `SELECT session_id AS sessionId, output_tokens AS outputTokens
         FROM token_usage ORDER BY session_id`,
      ).all()).toEqual([
        { sessionId: 'claude', outputTokens: 25 },
        { sessionId: 'codex-exact', outputTokens: 18 },
        { sessionId: 'codex-unknown', outputTokens: 25 },
      ]);
    } finally {
      db.close();
    }
  });
});
