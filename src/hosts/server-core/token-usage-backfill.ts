import type { Database } from 'better-sqlite3';

import {
  insertTokenUsageEvent,
  type TokenUsageRepo,
} from '@main/store/token-usage-repo';

interface LegacyTokenUsageEventRow {
  agent_id: string;
  payload_json: string;
  session_id: string;
  ts: number;
}

export interface ServerCoreTokenUsageBackfillResult {
  failed: number;
  persisted: number;
  scanned: number;
  skippedUnkeyed: number;
}

/**
 * Recovers token telemetry written to events by pre-fix Server Cores. Only provider-keyed rows are
 * replayed, so repeating startup remains idempotent through token_usage's message-id upsert.
 */
export function backfillServerCoreTokenUsageEvents(
  database: Database,
  tokenUsage: TokenUsageRepo,
): ServerCoreTokenUsageBackfillResult {
  const rows = database.prepare(
    `SELECT s.agent_id, e.payload_json, e.session_id, e.ts
       FROM events e
       JOIN sessions s ON s.id = e.session_id
      WHERE e.kind = 'token-usage'
      ORDER BY e.id ASC`,
  ).all() as LegacyTokenUsageEventRow[];
  const result: ServerCoreTokenUsageBackfillResult = {
    failed: 0,
    persisted: 0,
    scanned: rows.length,
    skippedUnkeyed: 0,
  };
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { messageId?: unknown };
      if (typeof payload.messageId !== 'string' || payload.messageId.length === 0) {
        result.skippedUnkeyed += 1;
        continue;
      }
      insertTokenUsageEvent(tokenUsage, {
        agentId: row.agent_id,
        kind: 'token-usage',
        payload,
        sessionId: row.session_id,
        source: 'sdk',
        ts: row.ts,
      });
      result.persisted += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
