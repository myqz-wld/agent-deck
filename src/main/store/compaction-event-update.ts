import type { AgentEvent } from '@shared/types';
import { compactionRecord } from '@shared/compaction';
import { getDb } from './db';
import { safeStringifyPayload } from './payload-truncate';

/** Retain lifecycle edges while coalescing streamed summary snapshots, like provider plan updates. */
export function updateExistingCompactionEvent(event: AgentEvent): number | null {
  if (event.kind !== 'message') return null;
  const payload = compactionRecord(event.payload);
  const id = compactionRecord(payload.compaction).id;
  if (payload.role !== 'system' || typeof id !== 'string' || !id) return null;
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM events WHERE session_id = ? AND kind = 'message'
    AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.compaction.id') END = ? LIMIT 1`)
    .get(event.sessionId, id) as { id: number } | undefined;
  if (!existing) return null;
  db.prepare('UPDATE events SET payload_json = ?, ts = ? WHERE id = ?')
    .run(safeStringifyPayload(event.payload), event.ts, existing.id);
  return existing.id;
}
