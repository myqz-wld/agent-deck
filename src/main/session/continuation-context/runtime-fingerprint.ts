import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

/** Hash the persisted runtime fields that continuation preparation must freeze before awaiting. */
export function continuationSessionRuntimeFingerprint(
  db: Database,
  sessionId: string,
): string | null {
  const runtimeRow = db
    .prepare(
      `SELECT agent_id, cwd, permission_mode, codex_sandbox, claude_code_sandbox,
              model, thinking, extra_allow_write, network_access_enabled,
              additional_directories
         FROM sessions
        WHERE id = ?`,
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  return runtimeRow
    ? createHash('sha256').update(JSON.stringify(runtimeRow), 'utf8').digest('hex')
    : null;
}
