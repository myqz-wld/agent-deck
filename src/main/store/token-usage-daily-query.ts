import type { Database } from 'better-sqlite3';
import {
  TOKEN_USAGE_METRIC,
  type TokenDailyRow,
} from '@shared/types';

export interface TokenDailySqlRow {
  bucketKey: string;
  day: string;
  providerTotalTokens: number | null;
  providerTotalApplicable: number;
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
}

export interface TokenUsageDailyQuery {
  sql: string;
  params: number[];
}

export function buildTokenUsageDailyQuery(
  fromMs?: number,
  toMs?: number,
): TokenUsageDailyQuery {
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
  return {
    sql:
      `SELECT model_bucket AS bucketKey,
                date(ts/1000, 'unixepoch', 'localtime') AS day,
                ${completeScopedSum('total_tokens', TOKEN_USAGE_METRIC.total)}
                  AS providerTotalTokens,
                ${scopedApplicable(TOKEN_USAGE_METRIC.total)}
                  AS providerTotalApplicable,
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
    params,
  };
}

export function queryTokenUsageDaily(
  db: Database,
  fromMs?: number,
  toMs?: number,
): TokenDailyRow[] {
  const { sql, params } = buildTokenUsageDailyQuery(fromMs, toMs);
  return mapTokenDailyRows(db.prepare(sql).all(...params) as TokenDailySqlRow[]);
}

export function mapTokenDailyRows(rows: TokenDailySqlRow[]): TokenDailyRow[] {
  return rows.map((row) => ({
    bucketKey: row.bucketKey,
    day: row.day,
    providerTotalTokens: row.providerTotalTokens,
    providerTotalApplicable: row.providerTotalApplicable > 0,
    inputTotalTokens: row.inputTotalTokens,
    inputTotalApplicable: row.inputTotalApplicable > 0,
    outputTokens: row.outputTokens,
    outputApplicable: row.outputApplicable > 0,
    reasoningTokens: row.reasoningTokens,
    reasoningApplicable: row.reasoningApplicable > 0,
    cacheReadTokens: row.cacheReadTokens,
    cacheReadApplicable: row.cacheReadApplicable > 0,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheCreationApplicable: row.cacheCreationApplicable > 0,
  }));
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
