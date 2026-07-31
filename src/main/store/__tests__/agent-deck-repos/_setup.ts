/** Shared better-sqlite3 probe, schema fixture, and session helper for repository tests. */

import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_SQL } from '../../schema';

export { bindingAvailable } from '../_binding-probe';

export function makeMemoryDb(dbPath = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  db.exec(CURRENT_SCHEMA_SQL);
  return db;
}

export function insertSession(db: Database.Database, id: string, agentId = 'claude-code'): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, ?, ?, ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, agentId, '/tmp', `title-${id}`, 1000, 1000);
}
