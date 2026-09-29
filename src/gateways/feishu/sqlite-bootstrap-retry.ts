import type Database from 'better-sqlite3';
import type { FeishuConfiguredCredential } from './types';

/** A failed first connection has no owner or user state to migrate to the new credential. */
export function isEmptyUnpairedBootstrapRetry(
  db: Database.Database,
  rows: readonly Record<string, unknown>[],
  next: FeishuConfiguredCredential,
): boolean {
  if (next.openId !== null || next.replacesCredentialId !== null ||
      rows.some((row) => row.open_id !== null)) return false;
  const userState = db.prepare(`
    SELECT 1 FROM contexts
    UNION ALL SELECT 1 FROM subscriptions
    UNION ALL SELECT 1 FROM deliveries
    UNION ALL SELECT 1 FROM cursors
    UNION ALL SELECT 1 FROM pairing_codes
    UNION ALL SELECT 1 FROM pairing_requests
    UNION ALL SELECT 1 FROM delete_confirmations
    LIMIT 1
  `).get();
  return userState === undefined;
}
