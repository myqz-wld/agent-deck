import type { Database } from 'better-sqlite3';
import { getDb } from './db';

export interface SessionHandOffAliasRow {
  sourceSessionId: string;
  successorSessionId: string;
}

export interface SessionHandOffAliasPageRequest {
  requestKey: string;
  successorSessionId: string;
  offset: number;
  limit: number;
}

export interface SessionHandOffAliasPageRow extends SessionHandOffAliasRow {
  requestKey: string;
}

export interface SessionHandOffAliasProbeRequest {
  requestKey: string;
  successorSessionId: string;
}

export interface SessionHandOffAliasProbeResult {
  requestKey: string;
  exhausted: boolean;
}

const ALIAS_LOOKUP_CHUNK_SIZE = 200;
const MAX_ALIAS_LOOKUP_ROWS_PER_SUCCESSOR = 1_024;

export function recordSessionHandOffAliasWithDb(
  db: Database,
  sourceSessionId: string,
  successorSessionId: string,
  createdAt = Date.now(),
): void {
  if (sourceSessionId === successorSessionId) {
    throw new Error('handoff alias source and successor must differ');
  }
  db.prepare(
    `INSERT INTO session_handoff_aliases
       (source_session_id, successor_session_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(source_session_id) DO UPDATE SET
       successor_session_id = excluded.successor_session_id,
       created_at = excluded.created_at`,
  ).run(sourceSessionId, successorSessionId, createdAt);
}

/** Point every older direct predecessor at the outgoing owner's new successor. */
export function compressSessionHandOffAliasesWithDb(
  db: Database,
  sourceSessionId: string,
  successorSessionId: string,
): number {
  return db
    .prepare(
      `UPDATE session_handoff_aliases
          SET successor_session_id = ?
        WHERE successor_session_id = ?`,
    )
    .run(successorSessionId, sourceSessionId).changes;
}

export function findSessionHandOffSuccessorWithDb(
  db: Database,
  sourceSessionId: string,
): string | null {
  return (db
    .prepare(
      `SELECT successor_session_id
         FROM session_handoff_aliases
        WHERE source_session_id = ?`,
    )
    .pluck()
    .get(sourceSessionId) as string | undefined) ?? null;
}

export function findSessionHandOffSuccessor(sourceSessionId: string): string | null {
  return findSessionHandOffSuccessorWithDb(getDb(), sourceSessionId);
}

export function listSessionHandOffPredecessorsWithDb(
  db: Database,
  successorSessionId: string,
): string[] {
  return db
    .prepare(
      `SELECT source_session_id
         FROM session_handoff_aliases
        WHERE successor_session_id = ?
        ORDER BY created_at ASC, source_session_id ASC`,
    )
    .pluck()
    .all(successorSessionId) as string[];
}

export function listSessionHandOffPredecessors(successorSessionId: string): string[] {
  return listSessionHandOffPredecessorsWithDb(getDb(), successorSessionId);
}

export function listSessionHandOffAliasesForSuccessorsWithDb(
  db: Database,
  successorSessionIds: readonly string[],
  maxRowsPerSuccessor = MAX_ALIAS_LOOKUP_ROWS_PER_SUCCESSOR,
  offsetsBySuccessor: ReadonlyMap<string, number> = new Map(),
): SessionHandOffAliasRow[] {
  const ids = [...new Set(successorSessionIds)];
  const rowLimit = Math.max(
    0,
    Math.min(Math.trunc(maxRowsPerSuccessor), MAX_ALIAS_LOOKUP_ROWS_PER_SUCCESSOR),
  );
  if (rowLimit === 0) return [];
  return listSessionHandOffAliasPagesWithDb(db, ids.map((successorSessionId, index) => ({
    requestKey: String(index),
    successorSessionId,
    offset: Math.max(0, Math.trunc(offsetsBySuccessor.get(successorSessionId) ?? 0)),
    limit: rowLimit,
  }))).map(({ sourceSessionId, successorSessionId }) => ({
    sourceSessionId,
    successorSessionId,
  })).sort((left, right) =>
    left.successorSessionId.localeCompare(right.successorSessionId) ||
    left.sourceSessionId.localeCompare(right.sourceSessionId));
}

/** Execute independently bounded pages in batched SQL, including repeated successors per owner. */
export function listSessionHandOffAliasPagesWithDb(
  db: Database,
  requests: readonly SessionHandOffAliasPageRequest[],
): SessionHandOffAliasPageRow[] {
  const normalized = requests.map((request) => ({
    requestKey: request.requestKey,
    successorSessionId: request.successorSessionId,
    offset: Math.max(0, Math.trunc(request.offset)),
    limit: Math.max(
      0,
      Math.min(Math.trunc(request.limit), MAX_ALIAS_LOOKUP_ROWS_PER_SUCCESSOR),
    ),
  })).filter((request) => request.limit > 0);
  const rows: SessionHandOffAliasPageRow[] = [];
  for (let offset = 0; offset < normalized.length; offset += ALIAS_LOOKUP_CHUNK_SIZE) {
    const chunk = normalized.slice(offset, offset + ALIAS_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const selects = chunk.map(() => `SELECT * FROM (
      SELECT ? AS request_key, source_session_id, successor_session_id
       FROM session_handoff_aliases
       WHERE successor_session_id = ?
       ORDER BY rowid ASC
       LIMIT ? OFFSET ?
    )`).join(' UNION ALL ');
    const params = chunk.flatMap((request) => [
      request.requestKey,
      request.successorSessionId,
      request.limit,
      request.offset,
    ]);
    const result = db.prepare(selects).all(...params) as Array<{
      request_key: string;
      source_session_id: string;
      successor_session_id: string;
    }>;
    rows.push(...result.map((row) => ({
      requestKey: row.request_key,
      sourceSessionId: row.source_session_id,
      successorSessionId: row.successor_session_id,
    })));
  }
  return rows;
}

/** Mark a whole frontier's empty leaves without issuing one synchronous query per node. */
export function probeSessionHandOffAliasesWithDb(
  db: Database,
  requests: readonly SessionHandOffAliasProbeRequest[],
): SessionHandOffAliasProbeResult[] {
  const successorIds = [...new Set(requests.map((request) => request.successorSessionId))];
  const present = new Set<string>();
  for (let offset = 0; offset < successorIds.length; offset += ALIAS_LOOKUP_CHUNK_SIZE) {
    const chunk = successorIds.slice(offset, offset + ALIAS_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT DISTINCT successor_session_id
         FROM session_handoff_aliases
        WHERE successor_session_id IN (${placeholders})`,
    ).pluck().all(...chunk) as string[];
    for (const successorSessionId of rows) present.add(successorSessionId);
  }
  return requests.map((request) => ({
    requestKey: request.requestKey,
    exhausted: !present.has(request.successorSessionId),
  }));
}

export function listSessionHandOffAliasesForSuccessors(
  successorSessionIds: readonly string[],
  maxRowsPerSuccessor?: number,
  offsetsBySuccessor?: ReadonlyMap<string, number>,
): SessionHandOffAliasRow[] {
  return listSessionHandOffAliasesForSuccessorsWithDb(
    getDb(),
    successorSessionIds,
    maxRowsPerSuccessor,
    offsetsBySuccessor,
  );
}

export function listSessionHandOffAliasPages(
  requests: readonly SessionHandOffAliasPageRequest[],
): SessionHandOffAliasPageRow[] {
  return listSessionHandOffAliasPagesWithDb(getDb(), requests);
}

export function probeSessionHandOffAliases(
  requests: readonly SessionHandOffAliasProbeRequest[],
): SessionHandOffAliasProbeResult[] {
  return probeSessionHandOffAliasesWithDb(getDb(), requests);
}

export function deleteSessionHandOffAliasWithDb(
  db: Database,
  sourceSessionId: string,
): boolean {
  return db
    .prepare(`DELETE FROM session_handoff_aliases WHERE source_session_id = ?`)
    .run(sourceSessionId).changes > 0;
}
