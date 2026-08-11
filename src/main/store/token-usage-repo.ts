/** Token usage persistence, reconciliation, and aggregation. */
import type { Database } from 'better-sqlite3';
import {
  type AgentEvent,
  TOKEN_USAGE_ALL_METRICS,
  TOKEN_USAGE_METRIC,
  type TokenUsagePayload,
  type TokenRateRow,
  type TokenDailyRow,
} from '@shared/types';
import { normalizeModel } from '@shared/model-normalize';
import { getDb } from './db';
import { deleteExpiredTokenUsageBatch } from './token-usage-retention';
import { queryTokenUsageDaily } from './token-usage-daily-query';
import { createTokenUsageDailyRollup } from './token-usage-daily-rollup';

export interface TokenUsageInsertInput extends TokenUsagePayload {
  sessionId: string;
  agentId: string;
  ts: number;
  matchGrokStandardFallback?: boolean;
}

export interface TokenUsageRepo {
  insert(input: TokenUsageInsertInput): void;
  today(startMs: number): TokenRateRow[];
  ratesSince(sinceMs: number): TokenRateRow[];
  dailyByModel(fromMs?: number, toMs?: number): TokenDailyRow[];
  deleteOlderThan(thresholdMs: number): number;
}

/** Shared AgentEvent projection used by both Desktop and headless Server Core ingestion. */
export function insertTokenUsageEvent(repo: TokenUsageRepo, event: AgentEvent): boolean {
  if (event.kind !== 'token-usage') return false;
  const payload = event.payload as TokenUsagePayload | null | undefined;
  if (!payload) return false;
  repo.insert({
    sessionId: event.sessionId,
    agentId: event.agentId,
    messageId: payload.messageId ?? null,
    model: payload.model ?? null,
    totalTokens: payload.totalTokens ?? null,
    inputTokens: payload.inputTokens ?? null,
    outputTokens: payload.outputTokens ?? null,
    reasoningTokens: payload.reasoningTokens ?? null,
    cacheReadTokens: payload.cacheReadTokens ?? null,
    cacheCreationTokens: payload.cacheCreationTokens ?? null,
    ...(payload.metricScope !== undefined ? { metricScope: payload.metricScope } : {}),
    ...(payload.grokUsageWatermark !== undefined
      ? { grokUsageWatermark: payload.grokUsageWatermark }
      : {}),
    ...(payload.replacesMessageId != null
      ? { replacesMessageId: payload.replacesMessageId }
      : {}),
    ts: event.ts,
  });
  return true;
}

export function createTokenUsageRepo(db: Database): TokenUsageRepo {
  let dailyRollup: ReturnType<typeof createTokenUsageDailyRollup> | undefined;

  function getDailyRollup(): ReturnType<typeof createTokenUsageDailyRollup> {
    if (dailyRollup) return dailyRollup;
    dailyRollup = createTokenUsageDailyRollup(db);
    return dailyRollup;
  }

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
    if (fromMs !== undefined || toMs !== undefined) {
      return queryTokenUsageDaily(db, fromMs, toMs);
    }
    return getDailyRollup().read();
  }

  function deleteOlderThan(thresholdMs: number): number {
    return deleteExpiredTokenUsageBatch(db, thresholdMs);
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
         ts                    = min(token_usage.ts, excluded.ts)
       WHERE
         (excluded.total_tokens IS NOT NULL
          AND (token_usage.total_tokens IS NULL
               OR excluded.total_tokens > token_usage.total_tokens))
         OR (excluded.input_tokens IS NOT NULL
             AND (token_usage.input_tokens IS NULL
                  OR excluded.input_tokens > token_usage.input_tokens))
         OR (excluded.output_tokens IS NOT NULL
             AND (token_usage.output_tokens IS NULL
                  OR excluded.output_tokens > token_usage.output_tokens))
         OR (excluded.reasoning_tokens IS NOT NULL
             AND (token_usage.reasoning_tokens IS NULL
                  OR excluded.reasoning_tokens > token_usage.reasoning_tokens))
         OR (excluded.cache_read_tokens IS NOT NULL
             AND (token_usage.cache_read_tokens IS NULL
                  OR excluded.cache_read_tokens > token_usage.cache_read_tokens))
         OR (excluded.cache_creation_tokens IS NOT NULL
             AND (token_usage.cache_creation_tokens IS NULL
                  OR excluded.cache_creation_tokens > token_usage.cache_creation_tokens))
         OR (token_usage.metric_scope | excluded.metric_scope) != token_usage.metric_scope
         OR token_usage.model_raw IS NOT excluded.model_raw
         OR token_usage.model_bucket IS NOT excluded.model_bucket
         OR excluded.ts < token_usage.ts`,
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

let _defaultRepo: TokenUsageRepo | null = null;
let _defaultDb: Database | null = null;
function defaultRepo(): TokenUsageRepo {
  const db = getDb();
  if (!_defaultRepo || _defaultDb !== db) {
    _defaultDb = db;
    _defaultRepo = createTokenUsageRepo(db);
  }
  return _defaultRepo;
}

export const tokenUsageRepo: TokenUsageRepo = {
  insert: (input) => defaultRepo().insert(input),
  today: (startMs) => defaultRepo().today(startMs),
  ratesSince: (sinceMs) => defaultRepo().ratesSince(sinceMs),
  dailyByModel: (fromMs, toMs) => defaultRepo().dailyByModel(fromMs, toMs),
  deleteOlderThan: (t) => defaultRepo().deleteOlderThan(t),
};
