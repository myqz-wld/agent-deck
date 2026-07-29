import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TOKEN_USAGE_ALL_METRICS,
  TOKEN_USAGE_METRIC,
} from '@shared/types';
import type { TokenUsageRepo } from '../token-usage-repo';
import {
  bindingAvailable,
  makeRepo,
  usage,
} from './token-usage-repo-test-helpers';

describe.skipIf(!bindingAvailable)('token-usage-repo / 查询', () => {
  let db: Database.Database;
  let repo: TokenUsageRepo;

  beforeEach(() => {
    ({ db, repo } = makeRepo());
  });
  afterEach(() => db.close());

  it('today：今日各 bucket output 总量降序', () => {
    const base = 2_000_000;
    repo.insert(usage({
      messageId: 'a',
      model: 'claude-opus-4-8',
      outputTokens: 30,
      ts: base,
    }));
    repo.insert(usage({
      messageId: 'b',
      model: 'claude-sonnet-4-5',
      outputTokens: 100,
      ts: base + 1,
    }));
    repo.insert(usage({
      messageId: 'c',
      model: 'claude-opus-4-8',
      outputTokens: 20,
      ts: base + 2,
    }));
    const rows = repo.today(base - 1);
    expect(rows[0]).toEqual({
      bucketKey: 'sonnet-4.5',
      outputTokens: 100,
    });
    expect(rows[1]).toEqual({
      bucketKey: 'opus-4.8',
      outputTokens: 50,
    });
  });

  it('ratesSince：窗口边界 ts >= sinceMs（含等于）', () => {
    repo.insert(usage({ messageId: 'old', outputTokens: 999, ts: 1_000 }));
    repo.insert(usage({ messageId: 'edge', outputTokens: 10, ts: 5_000 }));
    repo.insert(usage({ messageId: 'new', outputTokens: 20, ts: 6_000 }));
    const rows = repo.ratesSince(5_000);
    const total = rows.reduce((sum, row) => sum + row.outputTokens, 0);
    expect(total).toBe(30);
  });

  it('ratesSince：空窗口 → 空数组', () => {
    expect(repo.ratesSince(9_999_999)).toEqual([]);
  });

  it('today / ratesSince omit a bucket when any output value is unknown', () => {
    repo.insert(usage({
      messageId: 'known',
      model: 'grok-4.5',
      outputTokens: 20,
      ts: 5_000,
    }));
    repo.insert(usage({
      messageId: 'unknown',
      model: 'grok-4.5',
      outputTokens: null,
      ts: 5_001,
    }));
    repo.insert(usage({
      messageId: 'complete',
      model: 'gpt-5.5',
      outputTokens: 7,
      ts: 5_002,
    }));

    expect(repo.today(5_000)).toEqual([
      { bucketKey: 'gpt-5.5', outputTokens: 7 },
    ]);
    expect(repo.ratesSince(5_000)).toEqual([
      { bucketKey: 'gpt-5.5', outputTokens: 7 },
    ]);
  });

  it('dailyByModel：bucket × 本地日期 5 指标聚合', () => {
    const localNoon = new Date(2026, 5, 1, 12, 0, 0).getTime();
    repo.insert(usage({
      messageId: 'x',
      model: 'gpt-5.5',
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      ts: localNoon,
    }));
    repo.insert(usage({
      messageId: 'y',
      model: 'gpt-5.5',
      inputTokens: 7,
      outputTokens: 3,
      reasoningTokens: 4,
      ts: localNoon + 1_000,
    }));
    const gpt = repo.dailyByModel().find(
      (row) => row.bucketKey === 'gpt-5.5',
    );
    expect(gpt?.day).toBe('2026-06-01');
    expect(gpt?.inputTokens).toBe(17);
    expect(gpt?.inputTotalTokens).toBe(47);
    expect(gpt?.outputTokens).toBe(8);
    expect(gpt?.reasoningTokens).toBe(6);
  });

  it('dailyByModel：按 adapter 统一输入总量，避免重复计算缓存读写', () => {
    const localNoon = new Date(2026, 5, 2, 12, 0, 0).getTime();
    repo.insert(usage({
      messageId: 'claude-total',
      model: 'claude-opus-4-8',
      inputTokens: 10,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      ts: localNoon,
    }));
    repo.insert(usage({
      messageId: 'codex-total',
      agentId: 'codex-cli',
      model: 'gpt-5.5',
      inputTokens: 80,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
      ts: localNoon,
    }));

    const rows = repo.dailyByModel();
    expect(rows.find(
      (row) => row.bucketKey === 'opus-4.8',
    )?.inputTotalTokens).toBe(80);
    expect(rows.find(
      (row) => row.bucketKey === 'gpt-5.5',
    )?.inputTotalTokens).toBe(80);
  });

  it('a single finalized Claude row yields complete exact daily metrics', () => {
    const localNoon = new Date(2026, 5, 2, 13, 0, 0).getTime();
    repo.insert(usage({
      messageId: 'result:final:model:claude-opus-4-8',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 70,
      reasoningTokens: 18,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      ts: localNoon,
    }));

    expect(repo.dailyByModel().find(
      (row) => row.bucketKey === 'opus-4.8',
    )).toMatchObject({
      inputTokens: 100,
      inputTotalTokens: 140,
      outputTokens: 70,
      reasoningTokens: 18,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    });
  });

  it('scoped multi-model reasoning remains exact without poisoning unrelated totals', () => {
    const localNoon = new Date(2026, 5, 2, 14, 0, 0).getTime();
    repo.insert(usage({
      messageId: 'result:multi:model:claude-opus-4-8',
      model: 'claude-opus-4-8',
      inputTokens: 20,
      outputTokens: 8,
      reasoningTokens: null,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      metricScope: TOKEN_USAGE_ALL_METRICS & ~TOKEN_USAGE_METRIC.reasoning,
      ts: localNoon,
    }));
    repo.insert(usage({
      messageId: 'result:multi:reasoning:unattributed',
      model: 'claude-unattributed-reasoning',
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: 7,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      metricScope: TOKEN_USAGE_METRIC.reasoning,
      ts: localNoon,
    }));

    const rows = repo.dailyByModel();
    expect(rows.find(
      (row) => row.bucketKey === 'opus-4.8',
    )).toMatchObject({
      inputTotalTokens: 25,
      inputTotalApplicable: true,
      outputTokens: 8,
      outputApplicable: true,
      reasoningTokens: null,
      reasoningApplicable: false,
    });
    expect(rows.find(
      (row) => row.bucketKey === 'claude-unattributed-reasoning',
    )).toMatchObject({
      inputTotalTokens: null,
      inputTotalApplicable: false,
      outputTokens: null,
      outputApplicable: false,
      reasoningTokens: 7,
      reasoningApplicable: true,
    });
    expect(repo.today(localNoon - 1)).toEqual([
      { bucketKey: 'opus-4.8', outputTokens: 8 },
    ]);
  });

  it('dailyByModel exposes only complete exact metrics and provider totals', () => {
    const localNoon = new Date(2026, 5, 3, 12, 0, 0).getTime();
    repo.insert(usage({
      messageId: 'complete-1',
      agentId: 'grok-build',
      model: 'grok-4.5',
      totalTokens: 10,
      inputTokens: 7,
      outputTokens: 3,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: localNoon,
    }));
    repo.insert(usage({
      messageId: 'complete-2',
      agentId: 'grok-build',
      model: 'grok-4.5',
      totalTokens: 20,
      inputTokens: 14,
      outputTokens: 6,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ts: localNoon + 1,
    }));
    repo.insert(usage({
      messageId: 'incomplete-total',
      agentId: 'codex-cli',
      model: 'gpt-5.5',
      totalTokens: 30,
      inputTokens: 21,
      outputTokens: 9,
      ts: localNoon,
    }));
    repo.insert(usage({
      messageId: 'missing-total',
      agentId: 'codex-cli',
      model: 'gpt-5.5',
      totalTokens: null,
      inputTokens: 4,
      outputTokens: 2,
      ts: localNoon + 1,
    }));

    const rows = repo.dailyByModel();
    expect(rows.find(
      (row) => row.bucketKey === 'grok-4.5',
    )).toMatchObject({
      providerTotalTokens: 30,
      inputTokens: 21,
      inputTotalTokens: 21,
      outputTokens: 9,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(rows.find(
      (row) => row.bucketKey === 'gpt-5.5',
    )).toMatchObject({
      providerTotalTokens: null,
      inputTokens: 25,
      inputTotalTokens: 25,
      outputTokens: 11,
    });
  });
});
