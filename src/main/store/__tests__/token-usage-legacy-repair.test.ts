import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repairLegacyTokenUsage } from '../token-usage-legacy-repair';
import type { TokenUsageRepo } from '../token-usage-repo';
import {
  bindingAvailable,
  insertSession,
  makeRepo,
  usage,
} from './token-usage-repo-test-helpers';

describe.skipIf(!bindingAvailable)('legacy token usage repair', () => {
  let db: Database.Database;
  let repo: TokenUsageRepo;

  beforeEach(() => {
    ({ db, repo } = makeRepo());
    insertSession(db, 'claude-session');
    insertSession(db, 'codex-session', 'codex-cli');
  });

  afterEach(() => db.close());

  it('converts identifiable Claude cumulative result rows to additive deltas once', () => {
    repo.insert(usage({
      sessionId: 'claude-session',
      messageId: 'result:first:model:claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 10,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      ts: 1_000,
    }));
    repo.insert(usage({
      sessionId: 'claude-session',
      messageId: 'result:second:model:claude-opus-4-8',
      inputTokens: 130,
      outputTokens: 55,
      reasoningTokens: 14,
      cacheReadTokens: 27,
      cacheCreationTokens: 8,
      ts: 2_000,
    }));

    expect(repairLegacyTokenUsage(db)).toEqual({
      claudeCumulativeRows: 2,
      codexContextOnlyRows: 0,
    });
    expect(readClaudeRows(db)).toEqual([
      {
        messageId: 'repaired-result-delta-v2:first:model:claude-opus-4-8',
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 10,
        cacheReadTokens: 20,
        cacheCreationTokens: 5,
      },
      {
        messageId: 'repaired-result-delta-v2:second:model:claude-opus-4-8',
        inputTokens: 30,
        outputTokens: 15,
        reasoningTokens: 4,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
      },
    ]);
    expect(repairLegacyTokenUsage(db)).toEqual({
      claudeCumulativeRows: 0,
      codexContextOnlyRows: 0,
    });
    expect(readClaudeRows(db)[1]).toMatchObject({ inputTokens: 30, outputTokens: 15 });
  });

  it('subtracts prior authoritative assistant rows from the first cumulative result', () => {
    repo.insert(usage({
      sessionId: 'claude-session',
      messageId: 'assistant-before-regression',
      inputTokens: 60,
      outputTokens: 20,
      reasoningTokens: 2,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      ts: 500,
    }));
    repo.insert(usage({
      sessionId: 'claude-session',
      messageId: 'result:first:model:claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 35,
      reasoningTokens: 5,
      cacheReadTokens: 16,
      cacheCreationTokens: 2,
      ts: 1_000,
    }));

    repairLegacyTokenUsage(db);

    expect(readClaudeRows(db)[1]).toMatchObject({
      inputTokens: 40,
      outputTokens: 15,
      reasoningTokens: 3,
      cacheReadTokens: 6,
      cacheCreationTokens: 2,
    });
  });

  it('reconciles cumulative unattributed reasoning against prior session reasoning', () => {
    repo.insert(usage({
      sessionId: 'claude-session',
      messageId: 'assistant-reasoning',
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: 2,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: 500,
    }));
    for (const [messageId, reasoningTokens, ts] of [
      ['result:first:reasoning:unattributed', 10, 1_000],
      ['result:second:reasoning:unattributed', 15, 2_000],
    ] as const) {
      repo.insert(usage({
        sessionId: 'claude-session',
        messageId,
        model: 'claude-unattributed-reasoning',
        inputTokens: null,
        outputTokens: null,
        reasoningTokens,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        ts,
      }));
    }

    repairLegacyTokenUsage(db);

    expect(db.prepare(`
      SELECT reasoning_tokens AS reasoningTokens
        FROM token_usage
       WHERE message_id LIKE 'repaired-result-delta-v2:%:reasoning:unattributed'
       ORDER BY ts
    `).all()).toEqual([{ reasoningTokens: 8 }, { reasoningTokens: 5 }]);
  });

  it('deletes only exact legacy Codex context-only rows', () => {
    repo.insert(usage({
      sessionId: 'codex-session',
      agentId: 'codex-cli',
      messageId: null,
      model: 'gpt-5.6-sol',
      totalTokens: 250_000,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ts: 1_000,
    }));
    repo.insert(usage({
      sessionId: 'codex-session',
      agentId: 'codex-cli',
      messageId: null,
      model: 'gpt-5.6-sol',
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 7,
      cacheCreationTokens: 0,
      ts: 2_000,
    }));
    repo.insert(usage({
      sessionId: 'codex-session',
      agentId: 'codex-cli',
      messageId: 'codex-usage-v2:thread:300000-0-0-0-0-0',
      model: 'gpt-5.6-sol',
      totalTokens: 300_000,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ts: 3_000,
    }));

    expect(repairLegacyTokenUsage(db)).toEqual({
      claudeCumulativeRows: 0,
      codexContextOnlyRows: 1,
    });
    expect(db.prepare(`
      SELECT message_id AS messageId, total_tokens AS totalTokens
        FROM token_usage
       WHERE agent_id = 'codex-cli'
       ORDER BY ts
    `).all()).toEqual([
      { messageId: null, totalTokens: 15 },
      {
        messageId: 'codex-usage-v2:thread:300000-0-0-0-0-0',
        totalTokens: 300_000,
      },
    ]);
  });
});

function readClaudeRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT message_id AS messageId,
           input_tokens AS inputTokens,
           output_tokens AS outputTokens,
           reasoning_tokens AS reasoningTokens,
           cache_read_tokens AS cacheReadTokens,
           cache_creation_tokens AS cacheCreationTokens
      FROM token_usage
     WHERE agent_id = 'claude-code'
     ORDER BY ts, id
  `).all() as Array<Record<string, unknown>>;
}
