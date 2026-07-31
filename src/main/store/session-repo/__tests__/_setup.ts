/** Session repository SQLite fixture at the current schema version. */

import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_SQL } from '../../schema';

export { bindingAvailable } from '../../__tests__/_binding-probe';

/** Return an in-memory current-schema database; the caller owns closing it. */
export function makeMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  db.exec(CURRENT_SCHEMA_SQL);
  return db;
}
