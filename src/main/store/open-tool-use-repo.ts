import { getDb } from './db';
import log from '@main/utils/logger';

const logger = log.scope('open-tool-use-repo');

interface OpenToolUseRow {
  id: number;
  payload_json: string;
  tool_use_id: string;
}

export interface OpenToolUseRecord {
  toolUseId: string;
  toolName?: unknown;
  toolInput?: unknown;
}

/**
 * Reads tool starts that have no matching terminal event. This is intentionally
 * separate from event-repo.ts, which is already at the repository file-size limit.
 */
export const openToolUseRepo = {
  listForSession(sessionId: string): OpenToolUseRecord[] {
    const rows = getDb()
      .prepare(
        `SELECT start.id, start.payload_json, start.tool_use_id
           FROM events AS start
          WHERE start.session_id = ?
            AND start.kind = 'tool-use-start'
            AND start.tool_use_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM events AS terminal
               WHERE terminal.session_id = start.session_id
                 AND terminal.kind = 'tool-use-end'
                 AND terminal.tool_use_id = start.tool_use_id
            )
          ORDER BY start.ts ASC, start.id ASC`,
      )
      .all(sessionId) as OpenToolUseRow[];

    const records: OpenToolUseRecord[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        const value =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : {};
        records.push({
          toolUseId: row.tool_use_id,
          toolName: value.toolName,
          toolInput: value.toolInput,
        });
      } catch (error) {
        logger.warn('[open-tool-use-repo] payload JSON parse failed; row skipped', {
          eventId: row.id,
          sessionId,
          toolUseId: row.tool_use_id,
        }, error);
      }
    }
    return records;
  },
};
