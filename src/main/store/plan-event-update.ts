import type { AgentEvent } from '@shared/types';
import { planEventId } from '@shared/agent-event-update';
import { getDb } from './db';
import { safeStringifyPayload } from './payload-truncate';

/** Reuse an existing plan row without changing the current database schema. */
export function updateExistingPlanEvent(event: AgentEvent): number | null {
  const id = planEventId(event);
  if (!id) return null;
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM events WHERE session_id = ? AND kind = 'thinking'
    AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.planId') END = ? LIMIT 1`)
    .get(event.sessionId, id) as { id: number } | undefined;
  if (!existing) return null;
  db.prepare('UPDATE events SET payload_json = ?, ts = ? WHERE id = ?')
    .run(safeStringifyPayload(event.payload), event.ts, existing.id);
  return existing.id;
}
