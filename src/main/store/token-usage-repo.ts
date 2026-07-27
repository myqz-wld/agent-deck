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
 * - **dailyByModel(fromMs?,toMs?)**：bucket × 本地日期的统一 token 账本聚合（数据 tab 表格）。
 *
 * **边界参数（startMs/sinceMs/fromMs/toMs）由 caller（IPC handler 层）用本地 tz 算**（plan F6）——
 * repo 只收 epoch ms，仅 dailyByModel 的 day 分组用 SQL date(...,'localtime')。
 *
 * dailyByModel 同时返回 inputTotalTokens：Claude 的 input 字段不含 prompt cache，需把两类
 * cache 加回；Codex / Grok 的 input 字段已经包含缓存读，因此直接沿用原始 input。
 */
import type { Database } from 'better-sqlite3';
import {
  TOKEN_USAGE_ALL_METRICS,
  TOKEN_USAGE_METRIC,
  type TokenUsagePayload,
  type TokenRateRow,
  type TokenDailyRow,
} from '@shared/types';
import { normalizeModel } from '@shared/model-normalize';
import { getDb } from './db';

/** insert 入参：payload + 采集旁信息（sessionId / agentId / ts）。 */
export interface TokenUsageInsertInput extends TokenUsagePayload {
  sessionId: string;
  agentId: string;
  ts: number;
  /**
   * History-only reconciliation: replace the nearest metric-compatible provisional Grok standard
   * fallback before inserting the canonical provider prompt id.
   */
  matchGrokStandardFallback?: boolean;
}

export interface TokenUsageRepo {
  insert(input: TokenUsageInsertInput): void;
  /** 今日各 bucket output 总量降序（startMs = 本地午夜 epoch ms）。 */
  today(startMs: number): TokenRateRow[];
  /** 窗口内各 bucket output 总量（sinceMs = now - WINDOW_MS）。 */
  ratesSince(sinceMs: number): TokenRateRow[];
  /** bucket × 本地日期的统一 token 账本聚合（fromMs/toMs 可选，默认全量）。 */
  dailyByModel(fromMs?: number, toMs?: number): TokenDailyRow[];
  /** GC：删 ts < thresholdMs 的行（返回删除行数）。 */
  deleteOlderThan(thresholdMs: number): number;
}

export function createTokenUsageRepo(db: Database): TokenUsageRepo {
  function insert(input: TokenUsageInsertInput): void {
    const needsTransaction =
      input.grokUsageWatermark !== undefined ||
      input.replacesMessageId != null ||
      input.matchGrokStandardFallback === true;
    const persist = (): void => {
      const replacementId =
        input.replacesMessageId ??
        (input.matchGrokStandardFallback
          ? findMatchingGrokStandardFallback(db, input)
          : null);
      const merged = replacementId && replacementId !== input.messageId
        ? mergeAndDeleteReplacement(db, input, replacementId)
        : input;
      insertUsageRow(db, merged);
      if (input.grokUsageWatermark !== undefined) {
        if (input.agentId !== 'grok-build') {
          throw new Error('Only grok-build usage can advance a Grok usage watermark.');
        }
        const updated = db
          .prepare(`UPDATE sessions SET grok_usage_watermark = ? WHERE id = ?`)
          .run(JSON.stringify(input.grokUsageWatermark), input.sessionId);
        if (updated.changes !== 1) {
          throw new Error(
            `Cannot atomically persist Grok usage for missing session ${input.sessionId}`,
          );
        }
      }
    };
    if (needsTransaction) {
      db.transaction(persist)();
    } else {
      persist();
    }
  }

  function today(startMs: number): TokenRateRow[] {
    const rows = db
      .prepare(
        `SELECT model_bucket AS bucketKey, SUM(output_tokens) AS outputTokens
         FROM token_usage
         WHERE ts >= ? AND (metric_scope & ${TOKEN_USAGE_METRIC.output}) != 0
         GROUP BY model_bucket
         HAVING COUNT(*) = COUNT(output_tokens)
         ORDER BY outputTokens DESC`,
      )
      .all(startMs) as { bucketKey: string; outputTokens: number }[];
    return rows.map((r) => ({ bucketKey: r.bucketKey, outputTokens: r.outputTokens }));
  }

  function ratesSince(sinceMs: number): TokenRateRow[] {
    const rows = db
      .prepare(
        `SELECT model_bucket AS bucketKey, SUM(output_tokens) AS outputTokens
         FROM token_usage
         WHERE ts >= ? AND (metric_scope & ${TOKEN_USAGE_METRIC.output}) != 0
         GROUP BY model_bucket
         HAVING COUNT(*) = COUNT(output_tokens)
         ORDER BY outputTokens DESC`,
      )
      .all(sinceMs) as { bucketKey: string; outputTokens: number }[];
    return rows.map((r) => ({ bucketKey: r.bucketKey, outputTokens: r.outputTokens }));
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
                ${completeScopedSum('total_tokens', TOKEN_USAGE_METRIC.total)}
                  AS providerTotalTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.total)}
                  AS providerTotalApplicable,
                ${completeScopedSum('input_tokens', TOKEN_USAGE_METRIC.input)}
                  AS inputTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.input)}
                  AS inputApplicable,
                CASE
                  WHEN ${scopedCount(TOKEN_USAGE_METRIC.input)} = 0 THEN NULL
                  WHEN ${scopedCount(TOKEN_USAGE_METRIC.input)} = SUM(
                    CASE
                      WHEN (metric_scope & ${TOKEN_USAGE_METRIC.input}) = 0 THEN 0
                      WHEN input_tokens IS NULL THEN 0
                      WHEN agent_id = 'claude-code'
                       AND (metric_scope & ${TOKEN_USAGE_METRIC.cacheRead}) != 0
                       AND cache_read_tokens IS NULL THEN 0
                      WHEN agent_id = 'claude-code'
                       AND (metric_scope & ${TOKEN_USAGE_METRIC.cacheCreation}) != 0
                       AND cache_creation_tokens IS NULL THEN 0
                      ELSE 1
                    END
                  )
                  THEN SUM(
                    CASE
                      WHEN (metric_scope & ${TOKEN_USAGE_METRIC.input}) = 0 THEN 0
                      WHEN agent_id = 'claude-code'
                      THEN input_tokens
                         + CASE
                             WHEN (metric_scope & ${TOKEN_USAGE_METRIC.cacheRead}) != 0
                             THEN cache_read_tokens ELSE 0
                           END
                         + CASE
                             WHEN (metric_scope & ${TOKEN_USAGE_METRIC.cacheCreation}) != 0
                             THEN cache_creation_tokens ELSE 0
                           END
                      ELSE input_tokens
                    END
                  )
                  ELSE NULL
                END AS inputTotalTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.input)}
                  AS inputTotalApplicable,
                ${completeScopedSum('output_tokens', TOKEN_USAGE_METRIC.output)}
                  AS outputTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.output)}
                  AS outputApplicable,
                ${completeScopedSum('reasoning_tokens', TOKEN_USAGE_METRIC.reasoning)}
                  AS reasoningTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.reasoning)}
                  AS reasoningApplicable,
                ${completeScopedSum('cache_read_tokens', TOKEN_USAGE_METRIC.cacheRead)}
                  AS cacheReadTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.cacheRead)}
                  AS cacheReadApplicable,
                ${completeScopedSum(
                  'cache_creation_tokens',
                  TOKEN_USAGE_METRIC.cacheCreation,
                )} AS cacheCreationTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.cacheCreation)}
                  AS cacheCreationApplicable
         FROM token_usage ${where}
         GROUP BY model_bucket, day
         ORDER BY day DESC, COALESCE(outputTokens, -1) DESC`,
      )
      .all(...params) as {
      bucketKey: string;
      day: string;
      providerTotalTokens: number | null;
      providerTotalApplicable: number;
      inputTokens: number | null;
      inputApplicable: number;
      inputTotalTokens: number | null;
      inputTotalApplicable: number;
      outputTokens: number | null;
      outputApplicable: number;
      reasoningTokens: number | null;
      reasoningApplicable: number;
      cacheReadTokens: number | null;
      cacheReadApplicable: number;
      cacheCreationTokens: number | null;
      cacheCreationApplicable: number;
    }[];
    return rows.map((r) => ({
      bucketKey: r.bucketKey,
      day: r.day,
      providerTotalTokens: r.providerTotalTokens,
      providerTotalApplicable: r.providerTotalApplicable > 0,
      inputTokens: r.inputTokens,
      inputApplicable: r.inputApplicable > 0,
      inputTotalTokens: r.inputTotalTokens,
      inputTotalApplicable: r.inputTotalApplicable > 0,
      outputTokens: r.outputTokens,
      outputApplicable: r.outputApplicable > 0,
      reasoningTokens: r.reasoningTokens,
      reasoningApplicable: r.reasoningApplicable > 0,
      cacheReadTokens: r.cacheReadTokens,
      cacheReadApplicable: r.cacheReadApplicable > 0,
      cacheCreationTokens: r.cacheCreationTokens,
      cacheCreationApplicable: r.cacheCreationApplicable > 0,
    }));
  }

  function deleteOlderThan(thresholdMs: number): number {
    const info = db.prepare(`DELETE FROM token_usage WHERE ts < ?`).run(thresholdMs);
    return info.changes;
  }

  return { insert, today, ratesSince, dailyByModel, deleteOlderThan };
}

interface StoredUsageRow {
  message_id: string;
  model_raw: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  metric_scope: number;
  ts: number;
}

function insertUsageRow(db: Database, input: TokenUsageInsertInput): void {
  const bucket = normalizeModel(input.model).bucketKey;
  const modelRaw = input.model ?? '';
  const metricScope = normalizeMetricScope(input.metricScope);
  // max-merge 去重（plan R1 F1 + R2 H1）：partial UNIQUE(message_id) 作 conflict target
  // 必须重复 WHERE 谓词（REVIEW_52 约定，event-repo.ts:78-84 范式），否则 SQLite parse error。
  // codex message_id=NULL 不触发 partial UNIQUE → 每 turn 独立 INSERT 新行。
  db.prepare(
    `INSERT INTO token_usage
       (session_id, agent_id, message_id, model_raw, model_bucket,
        total_tokens, input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_creation_tokens, metric_scope, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) WHERE message_id IS NOT NULL
       DO UPDATE SET
         total_tokens          = ${nullableMax('total_tokens')},
         input_tokens          = ${nullableMax('input_tokens')},
         output_tokens         = ${nullableMax('output_tokens')},
         reasoning_tokens      = ${nullableMax('reasoning_tokens')},
         cache_read_tokens     = ${nullableMax('cache_read_tokens')},
         cache_creation_tokens = ${nullableMax('cache_creation_tokens')},
         metric_scope          = token_usage.metric_scope | excluded.metric_scope,
         model_raw             = excluded.model_raw,
         model_bucket          = excluded.model_bucket,
         ts                    = min(token_usage.ts, excluded.ts)`,
  ).run(
    input.sessionId,
    input.agentId,
    input.messageId,
    modelRaw,
    bucket,
    input.totalTokens ?? null,
    input.inputTokens,
    input.outputTokens,
    input.reasoningTokens ?? null,
    input.cacheReadTokens,
    input.cacheCreationTokens,
    metricScope,
    input.ts,
  );
}

function mergeAndDeleteReplacement(
  db: Database,
  input: TokenUsageInsertInput,
  replacementId: string,
): TokenUsageInsertInput {
  const stored = db
    .prepare(
      `SELECT message_id, model_raw, total_tokens, input_tokens, output_tokens,
              reasoning_tokens, cache_read_tokens, cache_creation_tokens,
              metric_scope, ts
         FROM token_usage
        WHERE message_id = ?
          AND session_id = ?
          AND agent_id = ?`,
    )
    .get(replacementId, input.sessionId, input.agentId) as StoredUsageRow | undefined;
  if (!stored) return input;
  db.prepare(
    `DELETE FROM token_usage
      WHERE message_id = ?
        AND session_id = ?
        AND agent_id = ?`,
  ).run(replacementId, input.sessionId, input.agentId);
  return {
    ...input,
    model: input.model ?? stored.model_raw,
    totalTokens: maxKnown(input.totalTokens ?? null, stored.total_tokens),
    inputTokens: maxKnown(input.inputTokens, stored.input_tokens),
    outputTokens: maxKnown(input.outputTokens, stored.output_tokens),
    reasoningTokens: maxKnown(input.reasoningTokens ?? null, stored.reasoning_tokens),
    cacheReadTokens: maxKnown(input.cacheReadTokens, stored.cache_read_tokens),
    cacheCreationTokens: maxKnown(
      input.cacheCreationTokens,
      stored.cache_creation_tokens,
    ),
    metricScope: normalizeMetricScope(input.metricScope) | stored.metric_scope,
    // The canonical extension/history event carries the provider timestamp. Do not retain the
    // provisional standard fallback's local timestamp after replacement.
    ts: input.ts,
  };
}

const GROK_STANDARD_MATCH_WINDOW_MS = 10 * 60 * 1000;
const GROK_ZERO_OVERLAP_MATCH_WINDOW_MS = 30 * 1000;

function findMatchingGrokStandardFallback(
  db: Database,
  input: TokenUsageInsertInput,
): string | null {
  if (input.agentId !== 'grok-build' || !input.messageId) return null;
  const canonicalExists = db
    .prepare(
      `SELECT 1
         FROM token_usage
        WHERE message_id = ?
          AND session_id = ?
          AND agent_id = 'grok-build'
        LIMIT 1`,
    )
    .get(input.messageId, input.sessionId);
  // Repeated history scans and progressive updates are canonical-id upserts. Once that id exists,
  // never let a later optional-only line consume a different provisional fallback.
  if (canonicalExists) return null;
  const rows = db
    .prepare(
      `SELECT message_id, model_raw, total_tokens, input_tokens, output_tokens,
              reasoning_tokens, cache_read_tokens, cache_creation_tokens,
              metric_scope, ts
         FROM token_usage
        WHERE session_id = ?
          AND agent_id = 'grok-build'
          AND message_id LIKE 'grok-standard:%'
          AND ts BETWEEN ? AND ?
        ORDER BY abs(ts - ?) ASC
        LIMIT 20`,
    )
    .all(
      input.sessionId,
      input.ts - GROK_STANDARD_MATCH_WINDOW_MS,
      input.ts + GROK_STANDARD_MATCH_WINDOW_MS,
      input.ts,
    ) as StoredUsageRow[];
  const candidates = rows.flatMap((row) => {
    if (!modelsCompatible(input.model, row.model_raw)) return [];
    const quality = metricMatchQuality(input, row, Math.abs(input.ts - row.ts));
    return quality ? [{ row, overlap: quality.overlap }] : [];
  });
  const overlapping = candidates.find((candidate) => candidate.overlap > 0);
  if (overlapping) return overlapping.row.message_id;
  const zeroOverlap = candidates.filter((candidate) => candidate.overlap === 0);
  return zeroOverlap.length === 1 ? zeroOverlap[0]?.row.message_id ?? null : null;
}

function metricMatchQuality(
  input: TokenUsageInsertInput,
  row: StoredUsageRow,
  distanceMs: number,
): { overlap: number } | null {
  const pairs: Array<[number | null, number | null]> = [
    [input.totalTokens ?? null, row.total_tokens],
    [input.inputTokens, row.input_tokens],
    [input.outputTokens, row.output_tokens],
    [input.reasoningTokens ?? null, row.reasoning_tokens],
    [input.cacheReadTokens, row.cache_read_tokens],
    [input.cacheCreationTokens, row.cache_creation_tokens],
  ];
  let overlap = 0;
  for (const [incoming, stored] of pairs) {
    if (incoming === null || stored === null) continue;
    if (incoming !== stored) return null;
    overlap += 1;
  }
  // Cache-write-only or reasoning-only extension records legitimately have no metric in common
  // with a standard ACP fallback. Permit that shape only in a tight timestamp window; any
  // contradictory shared metric still rejected above.
  if (overlap === 0 && distanceMs > GROK_ZERO_OVERLAP_MATCH_WINDOW_MS) {
    return null;
  }
  return { overlap };
}

function modelsCompatible(incoming: string | null, stored: string): boolean {
  const left = incoming?.trim() ?? '';
  const right = stored.trim();
  return !left || !right || left === right;
}

function maxKnown(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function nullableMax(column: string): string {
  return `CASE
    WHEN token_usage.${column} IS NULL THEN excluded.${column}
    WHEN excluded.${column} IS NULL THEN token_usage.${column}
    ELSE max(token_usage.${column}, excluded.${column})
  END`;
}

function scopedCount(metric: number): string {
  return `SUM(CASE WHEN (metric_scope & ${metric}) != 0 THEN 1 ELSE 0 END)`;
}

function scopedApplicable(metric: number): string {
  return `CASE WHEN ${scopedCount(metric)} > 0 THEN 1 ELSE 0 END`;
}

function completeScopedSum(column: string, metric: number): string {
  return `CASE
    WHEN ${scopedCount(metric)} = 0 THEN NULL
    WHEN SUM(
      CASE
        WHEN (metric_scope & ${metric}) != 0 AND ${column} IS NULL THEN 1
        ELSE 0
      END
    ) = 0
    THEN SUM(
      CASE
        WHEN (metric_scope & ${metric}) != 0 THEN COALESCE(${column}, 0)
        ELSE 0
      END
    )
    ELSE NULL
  END`;
}

function normalizeMetricScope(value: number | undefined): number {
  if (value === undefined) return TOKEN_USAGE_ALL_METRICS;
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    (value & ~TOKEN_USAGE_ALL_METRICS) !== 0
  ) {
    throw new Error(`Invalid token usage metric scope: ${String(value)}`);
  }
  return value;
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
