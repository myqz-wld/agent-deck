import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TokenUsageRepo } from '../token-usage-repo';
import {
  bindingAvailable,
  insertSession,
  makeRepo,
  usage,
} from './token-usage-repo-test-helpers';

describe.skipIf(!bindingAvailable)('token-usage-repo / Grok atomic accounting', () => {
  let db: Database.Database;
  let repo: TokenUsageRepo;

  const watermark = {
    totalTokens: 115,
    inputTokens: 90,
    outputTokens: 25,
    thoughtTokens: 3,
    cachedReadTokens: 10,
    cachedWriteTokens: null,
  };

  beforeEach(() => {
    ({ db, repo } = makeRepo());
    insertSession(db, 'grok-session', 'grok-build');
  });
  afterEach(() => db.close());

  it('commits the usage row and cumulative watermark in one transaction', () => {
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-1',
      model: 'grok-4.5',
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      grokUsageWatermark: watermark,
    }));

    expect(db.prepare(
      `SELECT message_id, total_tokens, input_tokens, output_tokens
         FROM token_usage`,
    ).get()).toEqual({
      message_id: 'grok-standard:grok-session:turn-1',
      total_tokens: 15,
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(db.prepare(
      `SELECT grok_usage_watermark AS watermark
         FROM sessions WHERE id = 'grok-session'`,
    ).get()).toEqual({ watermark: JSON.stringify(watermark) });
  });

  it('rolls back both the token row and watermark when either write fails', () => {
    db.exec(`
      CREATE TRIGGER fail_grok_watermark
      BEFORE UPDATE OF grok_usage_watermark ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'forced watermark failure');
      END
    `);

    expect(() => repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-fail',
      model: 'grok-4.5',
      grokUsageWatermark: watermark,
    }))).toThrow('forced watermark failure');

    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM token_usage',
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT grok_usage_watermark AS watermark
         FROM sessions WHERE id = 'grok-session'`,
    ).get()).toEqual({ watermark: null });
  });

  it('atomically replaces a provisional standard row with the provider prompt id', () => {
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-late',
      model: 'grok-4.5',
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      cacheReadTokens: 3,
      cacheCreationTokens: null,
      grokUsageWatermark: watermark,
      ts: 1_000,
    }));
    const nextWatermark = { ...watermark, cachedWriteTokens: 2 };
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'provider-prompt-late',
      replacesMessageId: 'grok-standard:grok-session:turn-late',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: 2,
      grokUsageWatermark: nextWatermark,
      ts: 2_000,
    }));

    expect(db.prepare(
      `SELECT message_id, total_tokens, input_tokens, output_tokens,
              reasoning_tokens, cache_read_tokens, cache_creation_tokens, ts
         FROM token_usage`,
    ).all()).toEqual([{
      message_id: 'provider-prompt-late',
      total_tokens: 15,
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 1,
      cache_read_tokens: 3,
      cache_creation_tokens: 2,
      ts: 2_000,
    }]);
    expect(db.prepare(
      `SELECT grok_usage_watermark AS watermark
         FROM sessions WHERE id = 'grok-session'`,
    ).get()).toEqual({ watermark: JSON.stringify(nextWatermark) });
  });

  it('history backfill reconciles a metric-compatible late extension without double counting', () => {
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-history',
      model: 'grok-4.5',
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: 10_000,
    }));
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'provider-history-prompt',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      matchGrokStandardFallback: true,
      ts: 10_100,
    }));

    expect(db.prepare(
      `SELECT message_id, total_tokens, input_tokens, output_tokens, reasoning_tokens
         FROM token_usage`,
    ).all()).toEqual([{
      message_id: 'provider-history-prompt',
      total_tokens: 15,
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 2,
    }]);
  });

  it.each([
    {
      label: 'cache-write-only',
      reasoningTokens: null,
      cacheCreationTokens: 2,
    },
    {
      label: 'reasoning-only',
      reasoningTokens: 3,
      cacheCreationTokens: null,
    },
  ])('history backfill reconciles a nearby $label extension', ({
    reasoningTokens,
    cacheCreationTokens,
  }) => {
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-optional',
      model: 'grok-4.5',
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: 10_000,
    }));
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: `provider-${reasoningTokens === null ? 'cache' : 'reasoning'}`,
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens,
      cacheReadTokens: null,
      cacheCreationTokens,
      matchGrokStandardFallback: true,
      ts: 10_100,
    }));

    const rows = db.prepare(
      `SELECT message_id, input_tokens, output_tokens, reasoning_tokens,
              cache_creation_tokens
         FROM token_usage`,
    ).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: reasoningTokens,
      cache_creation_tokens: cacheCreationTokens,
    });
  });

  it('leaves ambiguous zero-overlap history fallbacks separate', () => {
    for (const [messageId, ts] of [
      ['grok-standard:grok-session:turn-ambiguous-one', 10_000],
      ['grok-standard:grok-session:turn-ambiguous-two', 10_100],
    ] as const) {
      repo.insert(usage({
        sessionId: 'grok-session',
        agentId: 'grok-build',
        messageId,
        model: 'grok-4.5',
        totalTokens: null,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        ts,
      }));
    }
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'provider-ambiguous-cache',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: 2,
      matchGrokStandardFallback: true,
      ts: 10_050,
    }));

    expect(db.prepare(
      'SELECT message_id FROM token_usage ORDER BY message_id',
    ).all()).toEqual([
      { message_id: 'grok-standard:grok-session:turn-ambiguous-one' },
      { message_id: 'grok-standard:grok-session:turn-ambiguous-two' },
      { message_id: 'provider-ambiguous-cache' },
    ].sort((left, right) => left.message_id.localeCompare(right.message_id)));
  });

  it('does not let a repeated canonical history row consume another fallback', () => {
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-first',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: 10_000,
    }));
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'provider-progressive-cache',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: 2,
      matchGrokStandardFallback: true,
      ts: 10_001,
    }));
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-second',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: 7,
      outputTokens: 3,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: 10_010,
    }));
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'provider-progressive-cache',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: 1,
      cacheReadTokens: null,
      cacheCreationTokens: 2,
      matchGrokStandardFallback: true,
      ts: 10_011,
    }));

    expect(db.prepare(
      `SELECT message_id, input_tokens, output_tokens, reasoning_tokens,
              cache_creation_tokens
         FROM token_usage ORDER BY message_id`,
    ).all()).toEqual([
      {
        message_id: 'grok-standard:grok-session:turn-second',
        input_tokens: 7,
        output_tokens: 3,
        reasoning_tokens: null,
        cache_creation_tokens: null,
      },
      {
        message_id: 'provider-progressive-cache',
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 1,
        cache_creation_tokens: 2,
      },
    ]);
  });

  it('does not reconcile a zero-overlap history extension outside the tight window', () => {
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'grok-standard:grok-session:turn-distant',
      model: 'grok-4.5',
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: 10_000,
    }));
    repo.insert(usage({
      sessionId: 'grok-session',
      agentId: 'grok-build',
      messageId: 'provider-distant-cache',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: 2,
      matchGrokStandardFallback: true,
      ts: 40_001,
    }));

    expect(db.prepare(
      'SELECT message_id FROM token_usage ORDER BY message_id',
    ).all()).toEqual([
      { message_id: 'grok-standard:grok-session:turn-distant' },
      { message_id: 'provider-distant-cache' },
    ]);
  });
});
