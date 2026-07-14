/**
 * DB-injected event revision read model shared by the main process and readonly workers.
 * Keep this module free of the process DB facade, logger, Electron, and migrations.
 */
import type { Database } from 'better-sqlite3';

export const DEFAULT_EVENT_REVISION_PAGE_SIZE = 500;
export const MAX_EVENT_REVISION_PAGE_SIZE = 1_000;

/** Durable per-session cursor maintained by v037 triggers. */
export interface SessionEventRevisionState {
  sessionId: string;
  revision: number;
  rebuildAfterRevision: number;
}

/** Exclusive position in the effective-revision keyset. */
export interface EventRevisionCursor {
  revision: number;
  id: number;
}

/** A raw events row. `payloadJson` is intentionally unparsed. */
export interface RawEventRevisionRow {
  id: number;
  sessionId: string;
  effectiveRevision: number;
  kind: string;
  payloadJson: string;
  ts: number;
  toolUseId: string | null;
}

export interface ListRawEventRevisionsInput {
  sessionId: string;
  /** Read rows whose effective revision is at most this inclusive boundary. */
  throughRevision: number;
  /** Exclude this exact (effective revision, id) position and every earlier position. */
  after?: EventRevisionCursor;
  /** Clamped to [1, MAX_EVENT_REVISION_PAGE_SIZE]; omitted uses the page-size default. */
  limit?: number;
}

export interface EventRevisionRepo {
  state(sessionId: string): SessionEventRevisionState | null;
  listRawEvents(input: ListRawEventRevisionsInput): RawEventRevisionRow[];
}

interface RevisionStateRow {
  session_id: string;
  revision: number;
  rebuild_after_revision: number;
}

interface RawEventRow {
  id: number;
  session_id: string;
  effective_revision: number;
  kind: string;
  payload_json: string;
  ts: number;
  tool_use_id: string | null;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EVENT_REVISION_PAGE_SIZE;
  const integer = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_EVENT_REVISION_PAGE_SIZE;
  return Math.min(MAX_EVENT_REVISION_PAGE_SIZE, Math.max(1, integer));
}

function rowToState(row: RevisionStateRow): SessionEventRevisionState {
  return {
    sessionId: row.session_id,
    revision: row.revision,
    rebuildAfterRevision: row.rebuild_after_revision,
  };
}

function rowToRawEvent(row: RawEventRow): RawEventRevisionRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    effectiveRevision: row.effective_revision,
    kind: row.kind,
    payloadJson: row.payload_json,
    ts: row.ts,
    toolUseId: row.tool_use_id,
  };
}

export function createEventRevisionReadRepo(db: Database): EventRevisionRepo {
  function state(sessionId: string): SessionEventRevisionState | null {
    const row = db
      .prepare(
        `SELECT session_id, revision, rebuild_after_revision
           FROM session_event_revisions
          WHERE session_id = ?`,
      )
      .get(sessionId) as RevisionStateRow | undefined;
    return row ? rowToState(row) : null;
  }

  function listRawEvents(input: ListRawEventRevisionsInput): RawEventRevisionRow[] {
    const throughRevision = nonNegativeInteger(input.throughRevision, 0);
    const after = input.after && {
      revision: nonNegativeInteger(input.after.revision, 0),
      id: nonNegativeInteger(input.after.id, 0),
    };
    const whereAfter = after
      ? `\n            AND (COALESCE(change_revision, id), id) > (?, ?)`
      : '';
    const params = after
      ? [input.sessionId, throughRevision, after.revision, after.id, boundedLimit(input.limit)]
      : [input.sessionId, throughRevision, boundedLimit(input.limit)];
    const rows = db
      .prepare(
        `SELECT id,
                session_id,
                COALESCE(change_revision, id) AS effective_revision,
                kind,
                payload_json,
                ts,
                tool_use_id
           FROM events
          WHERE session_id = ?
            AND COALESCE(change_revision, id) <= ?${whereAfter}
          ORDER BY COALESCE(change_revision, id) ASC, id ASC
          LIMIT ?`,
      )
      .all(...params) as RawEventRow[];
    return rows.map(rowToRawEvent);
  }

  return { state, listRawEvents };
}

/** Backward-compatible name for process-local DB-injected callers. */
export const createEventRevisionRepo = createEventRevisionReadRepo;
