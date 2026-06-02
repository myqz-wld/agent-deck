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
    const row = db.prepare('SELECT model_raw, model_bucket FROM token_usage').get() as {
      model_raw: string;
      model_bucket: string;
    };
    expect(row.model_raw).toBe('claude-opus-4-8-thinking-max[1m]'); // 原值保粒度
    expect(row.model_bucket).toBe('opus-4.8'); // 归一聚合维度
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

  it('max-merge：4 指标各自独立取 max', () => {
    repo.insert(claudeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 5 }));
    repo.insert(claudeUsage({ inputTokens: 80, outputTokens: 90, cacheReadTokens: 10, cacheCreationTokens: 20 }));
    const row = db.prepare(
      'SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM token_usage',
    ).get() as Record<string, number>;
    expect(row.input_tokens).toBe(100); // max(100,80)
    expect(row.output_tokens).toBe(90); // max(50,90)
    expect(row.cache_read_tokens).toBe(200); // max(200,10)
    expect(row.cache_creation_tokens).toBe(20); // max(5,20)
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

  it('dailyByModel：bucket × 本地日期 4 指标聚合', () => {
    // 用本地午夜 + 12h 确保落在同一本地日（避开 tz 边界）
    const localNoon = new Date(2026, 5, 1, 12, 0, 0).getTime();
    repo.insert(claudeUsage({ messageId: 'x', model: 'gpt-5.5', inputTokens: 10, outputTokens: 5, ts: localNoon }));
    repo.insert(claudeUsage({ messageId: 'y', model: 'gpt-5.5', inputTokens: 7, outputTokens: 3, ts: localNoon + 1000 }));
    const rows = repo.dailyByModel();
    const gpt = rows.find((r) => r.bucketKey === 'gpt-5.5');
    expect(gpt?.day).toBe('2026-06-01');
    expect(gpt?.inputTokens).toBe(17); // 10 + 7
    expect(gpt?.outputTokens).toBe(8); // 5 + 3
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
  it('删 ts < threshold 的行', () => {
    const db = makeMemoryDb();
    const repo = createTokenUsageRepo(db);
    repo.insert(claudeUsage({ messageId: 'old', ts: 1000 }));
    repo.insert(claudeUsage({ messageId: 'new', ts: 9000 }));
    const deleted = repo.deleteOlderThan(5000);
    expect(deleted).toBe(1);
    const cnt = db.prepare('SELECT COUNT(*) c FROM token_usage').get() as { c: number };
    expect(cnt.c).toBe(1);
    db.close();
  });
});
