import type { SessionRecord } from '@shared/types';
import { getDb } from '../db';
import {
  buildKeywordPredicate,
  shouldIncludeLegacyEventIndex,
} from '../search-predicate';
import { rowToRecord, type Row } from './types';

/** User-facing History data source. Internal runtime rows are excluded in every filter mode. */
export function listHistory(
  opts: {
    agentId?: string;
    cwd?: string;
    fromTs?: number;
    toTs?: number;
    keyword?: string;
    archivedOnly?: boolean;
    spawnedBy?: string;
    limit?: number;
    offset?: number;
  } = {},
): SessionRecord[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const db = getDb();
  const conditions: string[] = ['hidden_from_history = 0'];
  const params: Record<string, unknown> = { limit, offset };

  conditions.push(opts.archivedOnly
    ? `archived_at IS NOT NULL`
    : `(lifecycle = 'closed' OR archived_at IS NOT NULL)`);
  if (opts.agentId) {
    conditions.push(`agent_id = @agent_id`);
    params.agent_id = opts.agentId;
  }
  if (opts.spawnedBy !== undefined) {
    conditions.push(`spawned_by = @spawned_by`);
    params.spawned_by = opts.spawnedBy;
  }
  if (opts.cwd) {
    conditions.push(`cwd LIKE @cwd ESCAPE '\\'`);
    const escaped = opts.cwd
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    params.cwd = `%${escaped}%`;
  }
  if (opts.fromTs) {
    conditions.push(`last_event_at >= @from_ts`);
    params.from_ts = opts.fromTs;
  }
  if (opts.toTs) {
    conditions.push(`last_event_at <= @to_ts`);
    params.to_ts = opts.toTs;
  }
  if (opts.keyword) {
    const pred = buildKeywordPredicate(opts.keyword, {
      includeLegacyEventIndex: shouldIncludeLegacyEventIndex(db),
    });
    conditions.push(pred.sql);
    Object.assign(params, pred.params);
  }
  const sql = `SELECT * FROM sessions WHERE ${conditions.join(' AND ')} ORDER BY last_event_at DESC LIMIT @limit OFFSET @offset`;
  const rows = db.prepare(sql).all(params) as Row[];
  return rows.map(rowToRecord);
}
