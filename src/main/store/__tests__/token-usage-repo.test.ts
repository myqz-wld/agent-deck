import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TokenUsageRepo } from '../token-usage-repo';
import {
  bindingAvailable,
  makeRepo,
  usage,
} from './token-usage-repo-test-helpers';

describe.skipIf(!bindingAvailable)('token-usage-repo / insert + max-merge', () => {
  let db: Database.Database;
  let repo: TokenUsageRepo;

  beforeEach(() => {
    ({ db, repo } = makeRepo());
  });
  afterEach(() => db.close());

  it('基本 insert：model_raw 原值 + model_bucket 归一（SSOT）', () => {
    repo.insert(usage({ model: 'claude-opus-4-8-thinking-max[1m]' }));
    const row = db.prepare(
      'SELECT model_raw, model_bucket, total_tokens FROM token_usage',
    ).get() as {
      model_raw: string;
      model_bucket: string;
      total_tokens: number | null;
    };
    expect(row.model_raw).toBe('claude-opus-4-8-thinking-max[1m]');
    expect(row.model_bucket).toBe('opus-4.8');
    expect(row.total_tokens).toBeNull();
  });

  it('total-only provider usage keeps the exact total and all unknown fields NULL', () => {
    repo.insert(usage({
      agentId: 'grok-build',
      messageId: 'total-only',
      model: 'grok-4.5',
      totalTokens: 77,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    }));
    expect(db.prepare(
      `SELECT total_tokens, input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_creation_tokens
         FROM token_usage WHERE message_id = 'total-only'`,
    ).get()).toEqual({
      total_tokens: 77,
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    });
  });

  it('GPT semantic suffix 保留，尾部 variant 只影响 bucket 不改 model_raw', () => {
    repo.insert(usage({
      messageId: 'gpt-sol',
      agentId: 'codex-cli',
      model: 'gpt-5.6-sol',
    }));
    repo.insert(usage({
      messageId: 'gpt-sol-variant',
      agentId: 'codex-cli',
      model: 'gpt-5.6-sol-thinking-max[1m]',
    }));

    expect(db.prepare(
      `SELECT model_raw AS modelRaw, model_bucket AS modelBucket
         FROM token_usage ORDER BY id`,
    ).all()).toEqual([
      { modelRaw: 'gpt-5.6-sol', modelBucket: 'gpt-5.6-sol' },
      {
        modelRaw: 'gpt-5.6-sol-thinking-max[1m]',
        modelBucket: 'gpt-5.6-sol',
      },
    ]);
  });

  it('max-merge：同 message_id 第二条 output 更大 → DB 更新为更大值', () => {
    repo.insert(usage({ outputTokens: 50 }));
    repo.insert(usage({ outputTokens: 90 }));
    const rows = db.prepare(
      'SELECT output_tokens FROM token_usage',
    ).all() as Array<{ output_tokens: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].output_tokens).toBe(90);
  });

  it('max-merge：同 message_id 第二条更小 → 不覆盖（保留更大值）', () => {
    repo.insert(usage({ outputTokens: 90 }));
    repo.insert(usage({ outputTokens: 30 }));
    const row = db.prepare(
      'SELECT output_tokens FROM token_usage',
    ).get() as { output_tokens: number };
    expect(row.output_tokens).toBe(90);
  });

  it('max-merge：5 指标各自独立取 max', () => {
    repo.insert(usage({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 7,
      cacheReadTokens: 200,
      cacheCreationTokens: 5,
    }));
    repo.insert(usage({
      inputTokens: 80,
      outputTokens: 90,
      reasoningTokens: 12,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
    }));
    const row = db.prepare(
      `SELECT input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_creation_tokens FROM token_usage`,
    ).get() as Record<string, number>;
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(90);
    expect(row.reasoning_tokens).toBe(12);
    expect(row.cache_read_tokens).toBe(200);
    expect(row.cache_creation_tokens).toBe(20);
  });

  it('max-merge preserves unknown separately from exact zero and known values', () => {
    repo.insert(usage({
      totalTokens: null,
      inputTokens: null,
      outputTokens: 0,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    }));
    repo.insert(usage({
      totalTokens: 12,
      inputTokens: 9,
      outputTokens: null,
      reasoningTokens: 0,
      cacheReadTokens: null,
      cacheCreationTokens: 3,
    }));
    repo.insert(usage({
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    }));

    expect(db.prepare(
      `SELECT total_tokens, input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_creation_tokens
         FROM token_usage WHERE message_id = 'm1'`,
    ).get()).toEqual({
      total_tokens: 12,
      input_tokens: 9,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: null,
      cache_creation_tokens: 3,
    });
  });

  it('codex NULL message_id 可插多行（不触发 partial UNIQUE）', () => {
    repo.insert(usage({
      messageId: null,
      agentId: 'codex-cli',
      model: 'gpt-5.5',
      outputTokens: 10,
    }));
    repo.insert(usage({
      messageId: null,
      agentId: 'codex-cli',
      model: 'gpt-5.5',
      outputTokens: 20,
    }));
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM token_usage WHERE message_id IS NULL',
    ).get()).toEqual({ count: 2 });
  });

  it('does not execute UPDATE for an actually unchanged same-message UPSERT', () => {
    const row = usage();
    repo.insert(row);
    const before = db.prepare(
      `SELECT source_revision AS revision,
              (SELECT COUNT(*) FROM token_usage_daily_dirty_days) AS dirty
         FROM token_usage_daily_state`,
    ).get();
    repo.insert(row);
    expect(db.prepare(
      `SELECT source_revision AS revision,
              (SELECT COUNT(*) FROM token_usage_daily_dirty_days) AS dirty
         FROM token_usage_daily_state`,
    ).get()).toEqual(before);
  });
});
