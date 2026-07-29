/**
 * token-usage-repo 真测（plan model-token-stats-and-dashboard-20260602 §Phase 2 Q1 /
 * 测试矩阵 repo 行）。in-memory better-sqlite3 真跑 v028 schema。
 *
 * binding 守门：bindingAvailable=false（runtime ABI 不匹配）时整 describe skip（CLAUDE.md
 * 约定，与 issue-repo.test.ts 同款 _setup probe）。
 *
 * 覆盖：
 * - max-merge：同 message_id 第二条 output 更大 → DB 更新更大值；更小值不覆盖；任一指标各自 max
 * - codex NULL message_id 可插多行（不触发 partial UNIQUE）
 * - today / ratesSince / dailyByModel 3 查询 SQL 正确
 * - session 删后 token_usage row 仍在（去硬 FK，F3）
 * - 模型归一集成：model_raw 原值 + model_bucket 归一（normalizeModel SSOT）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  TOKEN_USAGE_ALL_METRICS,
  TOKEN_USAGE_METRIC,
} from '@shared/types';
import { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';
import { createTokenUsageRepo, type TokenUsageRepo } from '../token-usage-repo';

function makeRepo(): { db: Database.Database; repo: TokenUsageRepo } {
  const db = makeMemoryDb();
  return { db, repo: createTokenUsageRepo(db) };
}

/** 默认 insert 入参（claude 形态，带 message_id）。 */
function claudeUsage(over: Partial<Parameters<TokenUsageRepo['insert']>[0]> = {}) {
  return {
    sessionId: 'sess-1',
    agentId: 'claude-code',
    messageId: 'm1',
    model: 'claude-opus-4-8',
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    ts: 1_000_000,
    ...over,
  };
}

describe.skipIf(!bindingAvailable)('token-usage-repo / insert + max-merge', () => {
  let db: Database.Database;
  let repo: TokenUsageRepo;
  beforeEach(() => {
    ({ db, repo } = makeRepo());
  });
  afterEach(() => db.close());

  it('基本 insert：model_raw 原值 + model_bucket 归一（SSOT）', () => {
    repo.insert(claudeUsage({ model: 'claude-opus-4-8-thinking-max[1m]' }));
    const row = db.prepare(
      'SELECT model_raw, model_bucket, total_tokens FROM token_usage',
    ).get() as {
      model_raw: string;
      model_bucket: string;
      total_tokens: number | null;
    };
    expect(row.model_raw).toBe('claude-opus-4-8-thinking-max[1m]'); // 原值保粒度
    expect(row.model_bucket).toBe('opus-4.8'); // 归一聚合维度
    expect(row.total_tokens).toBeNull();
  });

  it('total-only provider usage keeps the exact total and all unknown fields NULL', () => {
    repo.insert(
      claudeUsage({
        agentId: 'grok-build',
        messageId: 'total-only',
        model: 'grok-4.5',
        totalTokens: 77,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
    );
    expect(
      db.prepare(
        `SELECT total_tokens, input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_creation_tokens
           FROM token_usage WHERE message_id = 'total-only'`,
      ).get(),
    ).toEqual({
      total_tokens: 77,
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    });
  });

  it('GPT semantic suffix 保留，尾部 variant 只影响 bucket 不改 model_raw', () => {
    repo.insert(
      claudeUsage({
        messageId: 'gpt-sol',
        agentId: 'codex-cli',
        model: 'gpt-5.6-sol',
      }),
    );
    repo.insert(
      claudeUsage({
        messageId: 'gpt-sol-variant',
        agentId: 'codex-cli',
        model: 'gpt-5.6-sol-thinking-max[1m]',
      }),
    );

    expect(
      db
        .prepare(
          `SELECT model_raw AS modelRaw, model_bucket AS modelBucket
           FROM token_usage ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { modelRaw: 'gpt-5.6-sol', modelBucket: 'gpt-5.6-sol' },
      { modelRaw: 'gpt-5.6-sol-thinking-max[1m]', modelBucket: 'gpt-5.6-sol' },
    ]);
  });

  it('max-merge：同 message_id 第二条 output 更大 → DB 更新为更大值', () => {
    repo.insert(claudeUsage({ outputTokens: 50 }));
    repo.insert(claudeUsage({ outputTokens: 90 }));
    const rows = db.prepare('SELECT output_tokens FROM token_usage').all() as {
      output_tokens: number;
    }[];
    expect(rows).toHaveLength(1); // 同 message_id 只一行
    expect(rows[0].output_tokens).toBe(90);
  });

  it('max-merge：同 message_id 第二条更小 → 不覆盖（保留更大值）', () => {
    repo.insert(claudeUsage({ outputTokens: 90 }));
    repo.insert(claudeUsage({ outputTokens: 30 }));
    const row = db.prepare('SELECT output_tokens FROM token_usage').get() as { output_tokens: number };
    expect(row.output_tokens).toBe(90);
  });

  it('max-merge：5 指标各自独立取 max', () => {
    repo.insert(claudeUsage({ inputTokens: 100, outputTokens: 50, reasoningTokens: 7, cacheReadTokens: 200, cacheCreationTokens: 5 }));
    repo.insert(claudeUsage({ inputTokens: 80, outputTokens: 90, reasoningTokens: 12, cacheReadTokens: 10, cacheCreationTokens: 20 }));
    const row = db.prepare(
      'SELECT input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens FROM token_usage',
    ).get() as Record<string, number>;
    expect(row.input_tokens).toBe(100); // max(100,80)
    expect(row.output_tokens).toBe(90); // max(50,90)
    expect(row.reasoning_tokens).toBe(12); // max(7,12)
    expect(row.cache_read_tokens).toBe(200); // max(200,10)
    expect(row.cache_creation_tokens).toBe(20); // max(5,20)
  });

  it('max-merge preserves unknown separately from exact zero and known values', () => {
    repo.insert(
      claudeUsage({
        totalTokens: null,
        inputTokens: null,
        outputTokens: 0,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
    );
    repo.insert(
      claudeUsage({
        totalTokens: 12,
        inputTokens: 9,
        outputTokens: null,
        reasoningTokens: 0,
        cacheReadTokens: null,
        cacheCreationTokens: 3,
      }),
    );
    repo.insert(
      claudeUsage({
        totalTokens: null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
    );

    expect(
      db.prepare(
        `SELECT total_tokens, input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_creation_tokens
           FROM token_usage WHERE message_id = 'm1'`,
      ).get(),
    ).toEqual({
      total_tokens: 12,
      input_tokens: 9,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: null,
      cache_creation_tokens: 3,
    });
  });

  it('codex NULL message_id 可插多行（不触发 partial UNIQUE）', () => {
    repo.insert(claudeUsage({ messageId: null, agentId: 'codex-cli', model: 'gpt-5.5', outputTokens: 10 }));
    repo.insert(claudeUsage({ messageId: null, agentId: 'codex-cli', model: 'gpt-5.5', outputTokens: 20 }));
    const cnt = db.prepare('SELECT COUNT(*) c FROM token_usage WHERE message_id IS NULL').get() as {
      c: number;
    };
    expect(cnt.c).toBe(2); // 两行独立，不 merge
  });
});

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
    repo.insert(
      claudeUsage({
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
      }),
    );

    expect(
      db.prepare(
        `SELECT message_id, total_tokens, input_tokens, output_tokens
           FROM token_usage`,
      ).get(),
    ).toEqual({
      message_id: 'grok-standard:grok-session:turn-1',
      total_tokens: 15,
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(
      db.prepare(
        `SELECT grok_usage_watermark AS watermark
           FROM sessions WHERE id = 'grok-session'`,
      ).get(),
    ).toEqual({ watermark: JSON.stringify(watermark) });
  });

  it('rolls back both the token row and watermark when either write fails', () => {
    db.exec(`
      CREATE TRIGGER fail_grok_watermark
      BEFORE UPDATE OF grok_usage_watermark ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'forced watermark failure');
      END
    `);

    expect(() => {
      repo.insert(
        claudeUsage({
          sessionId: 'grok-session',
          agentId: 'grok-build',
          messageId: 'grok-standard:grok-session:turn-fail',
          model: 'grok-4.5',
          grokUsageWatermark: watermark,
        }),
      );
    }).toThrow('forced watermark failure');

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM token_usage`).get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare(
        `SELECT grok_usage_watermark AS watermark
           FROM sessions WHERE id = 'grok-session'`,
      ).get(),
    ).toEqual({ watermark: null });
  });

  it('atomically replaces a provisional standard row with the provider prompt id', () => {
    repo.insert(
      claudeUsage({
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
      }),
    );
    const nextWatermark = { ...watermark, cachedWriteTokens: 2 };
    repo.insert(
      claudeUsage({
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
      }),
    );

    expect(
      db.prepare(
        `SELECT message_id, total_tokens, input_tokens, output_tokens,
                reasoning_tokens, cache_read_tokens, cache_creation_tokens, ts
           FROM token_usage`,
      ).all(),
    ).toEqual([
      {
        message_id: 'provider-prompt-late',
        total_tokens: 15,
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 1,
        cache_read_tokens: 3,
        cache_creation_tokens: 2,
        ts: 2_000,
      },
    ]);
    expect(
      db.prepare(
        `SELECT grok_usage_watermark AS watermark
           FROM sessions WHERE id = 'grok-session'`,
      ).get(),
    ).toEqual({ watermark: JSON.stringify(nextWatermark) });
  });

  it('history backfill reconciles a metric-compatible late extension without double counting', () => {
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
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
      }),
    );

    expect(
      db.prepare(
        `SELECT message_id, total_tokens, input_tokens, output_tokens, reasoning_tokens
           FROM token_usage`,
      ).all(),
    ).toEqual([
      {
        message_id: 'provider-history-prompt',
        total_tokens: 15,
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 2,
      },
    ]);
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
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
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
      }),
    );

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
      repo.insert(
        claudeUsage({
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
        }),
      );
    }
    repo.insert(
      claudeUsage({
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
      }),
    );

    expect(
      db.prepare(`SELECT message_id FROM token_usage ORDER BY message_id`).all(),
    ).toEqual([
      { message_id: 'grok-standard:grok-session:turn-ambiguous-one' },
      { message_id: 'grok-standard:grok-session:turn-ambiguous-two' },
      { message_id: 'provider-ambiguous-cache' },
    ].sort((left, right) => left.message_id.localeCompare(right.message_id)));
  });

  it('does not let a repeated canonical history row consume another fallback', () => {
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
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
      }),
    );

    expect(
      db.prepare(
        `SELECT message_id, input_tokens, output_tokens, reasoning_tokens,
                cache_creation_tokens
           FROM token_usage
          ORDER BY message_id`,
      ).all(),
    ).toEqual([
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
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
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
      }),
    );

    expect(
      db.prepare(`SELECT message_id FROM token_usage ORDER BY message_id`).all(),
    ).toEqual([
      { message_id: 'grok-standard:grok-session:turn-distant' },
      { message_id: 'provider-distant-cache' },
    ]);
  });
});

describe.skipIf(!bindingAvailable)('token-usage-repo / 查询', () => {
  let db: Database.Database;
  let repo: TokenUsageRepo;
  beforeEach(() => {
    ({ db, repo } = makeRepo());
  });
  afterEach(() => db.close());

  it('today：今日各 bucket output 总量降序', () => {
    const base = 2_000_000;
    repo.insert(claudeUsage({ messageId: 'a', model: 'claude-opus-4-8', outputTokens: 30, ts: base }));
    repo.insert(claudeUsage({ messageId: 'b', model: 'claude-sonnet-4-5', outputTokens: 100, ts: base + 1 }));
    repo.insert(claudeUsage({ messageId: 'c', model: 'claude-opus-4-8', outputTokens: 20, ts: base + 2 }));
    const rows = repo.today(base - 1);
    // opus 合计 50，sonnet 100 → sonnet 在前（降序）
    expect(rows[0]).toEqual({ bucketKey: 'sonnet-4.5', outputTokens: 100 });
    expect(rows[1]).toEqual({ bucketKey: 'opus-4.8', outputTokens: 50 });
  });

  it('ratesSince：窗口边界 ts >= sinceMs（含等于）', () => {
    repo.insert(claudeUsage({ messageId: 'old', outputTokens: 999, ts: 1000 }));
    repo.insert(claudeUsage({ messageId: 'edge', outputTokens: 10, ts: 5000 }));
    repo.insert(claudeUsage({ messageId: 'new', outputTokens: 20, ts: 6000 }));
    const rows = repo.ratesSince(5000); // 含 ts=5000，排除 ts=1000
    const total = rows.reduce((s, r) => s + r.outputTokens, 0);
    expect(total).toBe(30); // 10 + 20，不含 old 的 999
  });

  it('ratesSince：空窗口 → 空数组', () => {
    expect(repo.ratesSince(9_999_999)).toEqual([]);
  });

  it('today / ratesSince omit a bucket when any output value is unknown', () => {
    repo.insert(
      claudeUsage({
        messageId: 'known',
        model: 'grok-4.5',
        outputTokens: 20,
        ts: 5_000,
      }),
    );
    repo.insert(
      claudeUsage({
        messageId: 'unknown',
        model: 'grok-4.5',
        outputTokens: null,
        ts: 5_001,
      }),
    );
    repo.insert(
      claudeUsage({
        messageId: 'complete',
        model: 'gpt-5.5',
        outputTokens: 7,
        ts: 5_002,
      }),
    );

    expect(repo.today(5_000)).toEqual([
      { bucketKey: 'gpt-5.5', outputTokens: 7 },
    ]);
    expect(repo.ratesSince(5_000)).toEqual([
      { bucketKey: 'gpt-5.5', outputTokens: 7 },
    ]);
  });

  it('dailyByModel：bucket × 本地日期 5 指标聚合', () => {
    // 用本地午夜 + 12h 确保落在同一本地日（避开 tz 边界）
    const localNoon = new Date(2026, 5, 1, 12, 0, 0).getTime();
    repo.insert(claudeUsage({ messageId: 'x', model: 'gpt-5.5', inputTokens: 10, outputTokens: 5, reasoningTokens: 2, ts: localNoon }));
    repo.insert(claudeUsage({ messageId: 'y', model: 'gpt-5.5', inputTokens: 7, outputTokens: 3, reasoningTokens: 4, ts: localNoon + 1000 }));
    const rows = repo.dailyByModel();
    const gpt = rows.find((r) => r.bucketKey === 'gpt-5.5');
    expect(gpt?.day).toBe('2026-06-01');
    expect(gpt?.inputTokens).toBe(17); // 10 + 7
    expect(gpt?.inputTotalTokens).toBe(47); // Claude 口径：input + 缓存读 + 缓存写
    expect(gpt?.outputTokens).toBe(8); // 5 + 3
    expect(gpt?.reasoningTokens).toBe(6); // 2 + 4
  });

  it('dailyByModel：按 adapter 统一输入总量，避免重复计算缓存读写', () => {
    const localNoon = new Date(2026, 5, 2, 12, 0, 0).getTime();
    repo.insert(
      claudeUsage({
        messageId: 'claude-total',
        model: 'claude-opus-4-8',
        inputTokens: 10,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        ts: localNoon,
      }),
    );
    repo.insert(
      claudeUsage({
        messageId: 'codex-total',
        agentId: 'codex-cli',
        model: 'gpt-5.5',
        inputTokens: 80,
        cacheReadTokens: 30,
        cacheCreationTokens: 0,
        ts: localNoon,
      }),
    );

    const rows = repo.dailyByModel();
    expect(rows.find((row) => row.bucketKey === 'opus-4.8')?.inputTotalTokens).toBe(80);
    expect(rows.find((row) => row.bucketKey === 'gpt-5.5')?.inputTotalTokens).toBe(80);
  });

  it('a single finalized Claude row yields complete exact daily metrics', () => {
    const localNoon = new Date(2026, 5, 2, 13, 0, 0).getTime();
    repo.insert(
      claudeUsage({
        messageId: 'result:final:model:claude-opus-4-8',
        model: 'claude-opus-4-8',
        inputTokens: 100,
        outputTokens: 70,
        reasoningTokens: 18,
        cacheReadTokens: 30,
        cacheCreationTokens: 10,
        ts: localNoon,
      }),
    );

    expect(repo.dailyByModel().find((row) => row.bucketKey === 'opus-4.8')).toMatchObject({
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
    repo.insert(
      claudeUsage({
        messageId: 'result:multi:model:claude-opus-4-8',
        model: 'claude-opus-4-8',
        inputTokens: 20,
        outputTokens: 8,
        reasoningTokens: null,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        metricScope: TOKEN_USAGE_ALL_METRICS & ~TOKEN_USAGE_METRIC.reasoning,
        ts: localNoon,
      }),
    );
    repo.insert(
      claudeUsage({
        messageId: 'result:multi:reasoning:unattributed',
        model: 'claude-unattributed-reasoning',
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: 7,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        metricScope: TOKEN_USAGE_METRIC.reasoning,
        ts: localNoon,
      }),
    );

    const rows = repo.dailyByModel();
    expect(rows.find((row) => row.bucketKey === 'opus-4.8')).toMatchObject({
      inputTotalTokens: 25,
      inputTotalApplicable: true,
      outputTokens: 8,
      outputApplicable: true,
      reasoningTokens: null,
      reasoningApplicable: false,
    });
    expect(
      rows.find((row) => row.bucketKey === 'claude-unattributed-reasoning'),
    ).toMatchObject({
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
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
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
      }),
    );
    repo.insert(
      claudeUsage({
        messageId: 'incomplete-total',
        agentId: 'codex-cli',
        model: 'gpt-5.5',
        totalTokens: 30,
        inputTokens: 21,
        outputTokens: 9,
        ts: localNoon,
      }),
    );
    repo.insert(
      claudeUsage({
        messageId: 'missing-total',
        agentId: 'codex-cli',
        model: 'gpt-5.5',
        totalTokens: null,
        inputTokens: 4,
        outputTokens: 2,
        ts: localNoon + 1,
      }),
    );

    const rows = repo.dailyByModel();
    expect(rows.find((row) => row.bucketKey === 'grok-4.5')).toMatchObject({
      providerTotalTokens: 30,
      inputTokens: 21,
      inputTotalTokens: 21,
      outputTokens: 9,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(rows.find((row) => row.bucketKey === 'gpt-5.5')).toMatchObject({
      providerTotalTokens: null,
      inputTokens: 25,
      inputTotalTokens: 25,
      outputTokens: 11,
    });
  });
});

describe.skipIf(!bindingAvailable)('token-usage-repo / 去硬 FK（F3）', () => {
  it('session 删除后 token_usage row 仍保留（无 FK CASCADE/SET NULL）', () => {
    const db = makeMemoryDb();
    const repo = createTokenUsageRepo(db);
    insertSession(db, 'sess-x');
    repo.insert(claudeUsage({ sessionId: 'sess-x' }));
    db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-x');
    const cnt = db.prepare('SELECT COUNT(*) c FROM token_usage').get() as { c: number };
    expect(cnt.c).toBe(1); // row 保留（统计不因 session GC 塌缩）
    db.close();
  });
});

describe.skipIf(!bindingAvailable)('token-usage-repo / deleteOlderThan (GC)', () => {
  it('deletes exactly 500 expired rows in deterministic oldest-first order', () => {
    const db = makeMemoryDb();
    const repo = createTokenUsageRepo(db);
    for (let i = 0; i < 500; i++) {
      repo.insert(claudeUsage({ messageId: `old-${i}`, ts: i + 1 }));
    }
    repo.insert(claudeUsage({ messageId: 'new', ts: 9000 }));

    expect(repo.deleteOlderThan(5000)).toBe(500);
    const rows = db
      .prepare('SELECT message_id FROM token_usage ORDER BY ts, id')
      .all() as Array<{ message_id: string }>;
    expect(rows.map((row) => row.message_id)).toEqual(['new']);
    db.close();
  });

  it('caps a 501-row backlog and drains it across bounded batches', () => {
    const db = makeMemoryDb();
    const repo = createTokenUsageRepo(db);
    for (let i = 0; i < 501; i++) {
      repo.insert(claudeUsage({ messageId: `expired-${i}`, ts: i + 1 }));
    }

    expect(repo.deleteOlderThan(5000)).toBe(500);
    const remaining = db
      .prepare('SELECT message_id, ts FROM token_usage ORDER BY ts, id')
      .all() as Array<{ message_id: string; ts: number }>;
    expect(remaining).toEqual([{ message_id: 'expired-500', ts: 501 }]);
    expect(repo.deleteOlderThan(5000)).toBe(1);
    expect(repo.deleteOlderThan(5000)).toBe(0);
    db.close();
  });

  it('drains a multi-batch backlog without exceeding the limit', () => {
    const db = makeMemoryDb();
    const repo = createTokenUsageRepo(db);
    for (let i = 0; i < 1001; i++) {
      repo.insert(claudeUsage({ messageId: `backlog-${i}`, ts: i + 1 }));
    }

    expect(repo.deleteOlderThan(5000)).toBe(500);
    expect(repo.deleteOlderThan(5000)).toBe(500);
    expect(repo.deleteOlderThan(5000)).toBe(1);
    expect(repo.deleteOlderThan(5000)).toBe(0);
    db.close();
  });
});
