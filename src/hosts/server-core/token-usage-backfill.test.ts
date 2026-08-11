import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindingAvailable,
  insertSession,
  makeRepo,
} from '@main/store/__tests__/token-usage-repo-test-helpers';
import type { TokenUsageRepo } from '@main/store/token-usage-repo';
import { backfillServerCoreTokenUsageEvents } from './token-usage-backfill';

describe.skipIf(!bindingAvailable)('Server Core token usage backfill', () => {
  let database: Database.Database;
  let tokenUsage: TokenUsageRepo;

  beforeEach(() => {
    ({ db: database, repo: tokenUsage } = makeRepo());
    insertSession(database, 'session-a', 'codex-cli');
  });
  afterEach(() => database.close());

  it('idempotently recovers keyed legacy events and skips unsafe rows', () => {
    const insert = database.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('session-a', 'token-usage', ?, ?)`,
    );
    insert.run(JSON.stringify({
      messageId: 'legacy-usage-a',
      model: 'gpt-5.6-sol',
      inputTokens: 100,
      outputTokens: 7,
    }), 1_000);
    insert.run(JSON.stringify({ model: 'gpt-5.6-sol', outputTokens: 9 }), 1_001);
    insert.run('{invalid', 1_002);

    expect(backfillServerCoreTokenUsageEvents(database, tokenUsage)).toEqual({
      failed: 1,
      persisted: 1,
      scanned: 3,
      skippedUnkeyed: 1,
    });
    expect(database.prepare(
      `SELECT agent_id AS agentId, message_id AS messageId, model_raw AS model,
              input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM token_usage`,
    ).all()).toEqual([{
      agentId: 'codex-cli',
      messageId: 'legacy-usage-a',
      model: 'gpt-5.6-sol',
      inputTokens: 100,
      outputTokens: 7,
    }]);

    backfillServerCoreTokenUsageEvents(database, tokenUsage);
    expect(database.prepare('SELECT COUNT(*) AS count FROM token_usage').get())
      .toEqual({ count: 1 });
  });
});
