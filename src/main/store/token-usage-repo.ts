/**
 * token_usage 持久层（plan model-token-stats-and-dashboard-20260602 §Phase 2 Q1）。
 *
 * facade 范式同 issue-repo（createTokenUsageRepo(db) + lazy singleton tokenUsageRepo）。
 * 列名 snake_case（SQLite 惯例），TS / 返回 camelCase。timestamp INTEGER epoch ms。
 *
 * 四个能力（详 plan §查询层）：
 * - **insert**：写一条 token 用量。max-merge 去重（claude 同 message_id 取各指标最大；
 *   codex message_id=NULL 每 turn 独立行）。bucket 在写时经 normalizeModel(model_raw) 算（SSOT）。
 * - **today(startMs)**：今日各 bucket 的 output 总量（Top3 排名 + 数据页今日汇总）。
 * - **ratesSince(sinceMs)**：滑动窗口各 bucket output 总量（token/s = out ÷ 窗口秒数，renderer 算）。
 * - **dailyByModel(fromMs?,toMs?)**：bucket × 本地日期的 4 指标聚合（数据 tab 表格）。
 *
 * **边界参数（startMs/sinceMs/fromMs/toMs）由 caller（IPC handler 层）用本地 tz 算**（plan F6）——
 * repo 只收 epoch ms，仅 dailyByModel 的 day 分组用 SQL date(...,'localtime')。
 */
import type { Database } from 'better-sqlite3';
import type { TokenUsagePayload, TokenRateRow, TokenDailyRow } from '@shared/types';
import { normalizeModel } from '@shared/model-normalize';
import { getDb } from './db';

/** insert 入参：payload + 采集旁信息（sessionId / agentId / ts）。 */
export interface TokenUsageInsertInput extends TokenUsagePayload {
  sessionId: string;
  agentId: string;
  ts: number;
}

export interface TokenUsageRepo {
  insert(input: TokenUsageInsertInput): void;
  /** 今日各 bucket output 总量降序（startMs = 本地午夜 epoch ms）。 */
  today(startMs: number): TokenRateRow[];
  /** 窗口内各 bucket output 总量（sinceMs = now - WINDOW_MS）。 */
  ratesSince(sinceMs: number): TokenRateRow[];
  /** bucket × 本地日期的 4 指标聚合（fromMs/toMs 可选，默认全量）。 */
  dailyByModel(fromMs?: number, toMs?: number): TokenDailyRow[];
  /** GC：删 ts < thresholdMs 的行（返回删除行数）。 */
  deleteOlderThan(thresholdMs: number): number;
}

export function createTokenUsageRepo(db: Database): TokenUsageRepo {
  function insert(input: TokenUsageInsertInput): void {
    const bucket = normalizeModel(input.model).bucketKey;
    const modelRaw = input.model ?? '';
    // max-merge 去重（plan R1 F1 + R2 H1）：partial UNIQUE(message_id) 作 conflict target
    // 必须重复 WHERE 谓词（REVIEW_52 约定，event-repo.ts:78-84 范式），否则 SQLite parse error。
    // codex message_id=NULL 不触发 partial UNIQUE → 每 turn 独立 INSERT 新行。
    db.prepare(
      `INSERT INTO token_usage
         (session_id, agent_id, message_id, model_raw, model_bucket,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) WHERE message_id IS NOT NULL
         DO UPDATE SET
           input_tokens          = max(input_tokens, excluded.input_tokens),
           output_tokens         = max(output_tokens, excluded.output_tokens),
           cache_read_tokens     = max(cache_read_tokens, excluded.cache_read_tokens),
           cache_creation_tokens = max(cache_creation_tokens, excluded.cache_creation_tokens)`,
    ).run(
      input.sessionId,
      input.agentId,
      input.messageId,
      modelRaw,
      bucket,
      input.inputTokens,
      input.outputTokens,
      input.cacheReadTokens,
      input.cacheCreationTokens,
      input.ts,
    );
  }

  function today(startMs: number): TokenRateRow[] {
    const rows = db
      .prepare(
        `SELECT model_bucket AS bucketKey, SUM(output_tokens) AS outputTokens
         FROM token_usage WHERE ts >= ?
         GROUP BY model_bucket ORDER BY outputTokens DESC`,
      )
      .all(startMs) as { bucketKey: string; outputTokens: number }[];
    return rows.map((r) => ({ bucketKey: r.bucketKey, outputTokens: r.outputTokens ?? 0 }));
  }

  function ratesSince(sinceMs: number): TokenRateRow[] {
    const rows = db
      .prepare(
        `SELECT model_bucket AS bucketKey, SUM(output_tokens) AS outputTokens
         FROM token_usage WHERE ts >= ?
         GROUP BY model_bucket ORDER BY outputTokens DESC`,
      )
      .all(sinceMs) as { bucketKey: string; outputTokens: number }[];
    return rows.map((r) => ({ bucketKey: r.bucketKey, outputTokens: r.outputTokens ?? 0 }));
  }

  function dailyByModel(fromMs?: number, toMs?: number): TokenDailyRow[] {
    // 本地日期分组（plan 午夜边界）：date(ts/1000,'unixepoch','localtime') 把 epoch ms 转本地日。
    const clauses: string[] = [];
    const params: number[] = [];
    if (fromMs !== undefined) {
      clauses.push('ts >= ?');
      params.push(fromMs);
    }
    if (toMs !== undefined) {
      clauses.push('ts < ?');
      params.push(toMs);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT model_bucket AS bucketKey,
                date(ts/1000, 'unixepoch', 'localtime') AS day,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                SUM(cache_read_tokens) AS cacheReadTokens,
                SUM(cache_creation_tokens) AS cacheCreationTokens
         FROM token_usage ${where}
         GROUP BY model_bucket, day
         ORDER BY day DESC, outputTokens DESC`,
      )
      .all(...params) as {
      bucketKey: string;
      day: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }[];
    return rows.map((r) => ({
      bucketKey: r.bucketKey,
      day: r.day,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheCreationTokens: r.cacheCreationTokens ?? 0,
    }));
  }

  function deleteOlderThan(thresholdMs: number): number {
    const info = db.prepare(`DELETE FROM token_usage WHERE ts < ?`).run(thresholdMs);
    return info.changes;
  }

  return { insert, today, ratesSince, dailyByModel, deleteOlderThan };
}

// ═══════════════════════════════════════════════════════════════════════════
// Default lazy singleton（与 issue-repo / task-repo / session-repo 同款 pattern）
// ═══════════════════════════════════════════════════════════════════════════

let _defaultRepo: TokenUsageRepo | null = null;
function defaultRepo(): TokenUsageRepo {
  if (!_defaultRepo) _defaultRepo = createTokenUsageRepo(getDb());
  return _defaultRepo;
}

export const tokenUsageRepo: TokenUsageRepo = {
  insert: (input) => defaultRepo().insert(input),
  today: (startMs) => defaultRepo().today(startMs),
  ratesSince: (sinceMs) => defaultRepo().ratesSince(sinceMs),
  dailyByModel: (fromMs, toMs) => defaultRepo().dailyByModel(fromMs, toMs),
  deleteOlderThan: (t) => defaultRepo().deleteOlderThan(t),
};
