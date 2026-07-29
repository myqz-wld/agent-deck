import type { Database } from 'better-sqlite3';

export const TOKEN_USAGE_GC_BATCH_LIMIT = 500;

export const DELETE_EXPIRED_TOKEN_USAGE_BATCH_SQL = `
  DELETE FROM token_usage
  WHERE id IN (
    SELECT id
    FROM token_usage
    WHERE ts < ?
    ORDER BY ts ASC, id ASC
    LIMIT ?
  )
`;

/** Delete one deterministic oldest-first retention batch. */
export function deleteExpiredTokenUsageBatch(
  db: Database,
  thresholdMs: number,
): number {
  return db
    .prepare(DELETE_EXPIRED_TOKEN_USAGE_BATCH_SQL)
    .run(thresholdMs, TOKEN_USAGE_GC_BATCH_LIMIT).changes;
}
