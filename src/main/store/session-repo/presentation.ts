import type { SessionPresentationCountsDto, SessionPresentationKind } from '@contracts/index';
import type { SessionRecord } from '@shared/types';

import { getDb } from '../db';
import { buildKeywordPredicate } from '../search-predicate';
import { rowToRecord, type Row } from './types';

export interface SessionPresentationRecord {
  record: SessionRecord;
  contextOnly: boolean;
}

export interface SessionPresentationPage {
  records: SessionPresentationRecord[];
  contextTruncated: boolean;
}

function historyWhere(query: string | undefined, archivedOnly = false): {
  sql: string;
  params: Record<string, unknown>;
} {
  const conditions = [
    'hidden_from_history = 0',
    archivedOnly ? 'archived_at IS NOT NULL' : `(lifecycle = 'closed' OR archived_at IS NOT NULL)`,
  ];
  const params: Record<string, unknown> = {};
  const normalized = query?.trim();
  if (normalized) {
    const predicate = buildKeywordPredicate(normalized);
    conditions.push(predicate.sql);
    Object.assign(params, predicate.params);
  }
  return { sql: conditions.join(' AND '), params };
}

/**
 * Returns the pinned-first live page plus bounded structural owners required by the shared tree.
 * Context rows never consume the caller's primary page limit.
 */
export function listLivePresentation(
  limit: number,
  offset: number,
  maximumContextRows: number,
): SessionPresentationPage {
  const maximumRows = limit + maximumContextRows;
  type PresentationRow = Row & { context_only: number };
  const rows = getDb().prepare(
    `WITH RECURSIVE
       seed_ids(id) AS (
         SELECT id FROM sessions
          WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant')
          ORDER BY pinned_at DESC, last_event_at DESC, id ASC
          LIMIT @limit OFFSET @offset
       ),
       visible_ids(id) AS (
         SELECT id FROM seed_ids
         UNION
         SELECT parent.id
           FROM visible_ids visible
           JOIN sessions child ON child.id = visible.id
           JOIN sessions parent ON parent.id = child.spawned_by
          WHERE parent.archived_at IS NULL
            AND parent.lifecycle IN ('active', 'dormant')
         UNION
         SELECT lead_session.id
           FROM visible_ids visible
           JOIN agent_deck_team_members teammate
             ON teammate.session_id = visible.id
            AND teammate.role = 'teammate'
            AND teammate.left_at IS NULL
           JOIN agent_deck_team_members lead
             ON lead.team_id = teammate.team_id
            AND lead.role = 'lead'
            AND lead.left_at IS NULL
           JOIN sessions lead_session ON lead_session.id = lead.session_id
          WHERE lead_session.archived_at IS NULL
            AND lead_session.lifecycle IN ('active', 'dormant')
       )
     SELECT session.*,
            CASE WHEN seed.id IS NULL THEN 1 ELSE 0 END AS context_only
       FROM sessions session
       JOIN visible_ids visible ON visible.id = session.id
       LEFT JOIN seed_ids seed ON seed.id = session.id
      ORDER BY context_only ASC, session.pinned_at DESC, session.last_event_at DESC, session.id ASC
      LIMIT @maximum_plus_one`,
  ).all({ limit, offset, maximum_plus_one: maximumRows + 1 }) as PresentationRow[];
  return {
    records: rows.slice(0, maximumRows).map((row) => ({
      record: rowToRecord(row),
      contextOnly: row.context_only === 1,
    })),
    contextTruncated: rows.length > maximumRows,
  };
}

export function listHistoryPresentation(
  query: string | undefined,
  archivedOnly: boolean,
  limit: number,
  offset: number,
): SessionPresentationPage {
  const where = historyWhere(query, archivedOnly);
  const rows = getDb().prepare(
    `SELECT * FROM sessions
      WHERE ${where.sql}
      ORDER BY last_event_at DESC, id ASC
      LIMIT @limit OFFSET @offset`,
  ).all({ ...where.params, limit, offset }) as Row[];
  return {
    records: rows.map((row) => ({ record: rowToRecord(row), contextOnly: false })),
    contextTruncated: false,
  };
}

export function sessionPresentationCounts(
  kind: SessionPresentationKind,
  query?: string,
  archivedOnly = false,
): SessionPresentationCountsDto {
  const where = kind === 'live'
    ? { sql: `archived_at IS NULL AND lifecycle IN ('active', 'dormant')`, params: {} }
    : historyWhere(query, archivedOnly);
  const row = getDb().prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN lifecycle = 'dormant' THEN 1 ELSE 0 END) AS dormant,
       SUM(CASE WHEN lifecycle = 'closed' THEN 1 ELSE 0 END) AS closed,
       SUM(CASE WHEN activity = 'working' THEN 1 ELSE 0 END) AS working,
       SUM(CASE WHEN activity = 'waiting' THEN 1 ELSE 0 END) AS waiting
     FROM sessions WHERE ${where.sql}`,
  ).get(where.params) as Record<keyof SessionPresentationCountsDto, number | null>;
  return {
    total: Number(row.total ?? 0),
    active: Number(row.active ?? 0),
    dormant: Number(row.dormant ?? 0),
    closed: Number(row.closed ?? 0),
    working: Number(row.working ?? 0),
    waiting: Number(row.waiting ?? 0),
  };
}
