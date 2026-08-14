import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

const CURRENT_SCHEMA_VERSION = 2;

const CURRENT_SCHEMA_SQL = `
CREATE TABLE core_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  current_revision INTEGER NOT NULL CHECK(current_revision >= 0)
) STRICT;
CREATE TABLE change_log (
  revision INTEGER PRIMARY KEY CHECK(revision > 0),
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 128),
  entity_id TEXT CHECK(entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TABLE mutation_ledger (
  connection_scope TEXT NOT NULL CHECK(length(connection_scope) BETWEEN 1 AND 256),
  access_surface TEXT NOT NULL CHECK(access_surface IN ('desktop', 'feishu')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
  method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
  status TEXT NOT NULL CHECK(status IN ('invoking', 'completed')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  revision INTEGER CHECK(revision IS NULL OR revision >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(connection_scope, access_surface, idempotency_key)
) STRICT;
CREATE TABLE session_subscriptions (
  connection_scope TEXT NOT NULL CHECK(length(connection_scope) BETWEEN 1 AND 256),
  access_surface TEXT NOT NULL CHECK(access_surface IN ('desktop', 'feishu')),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
  subscribed INTEGER NOT NULL CHECK(subscribed IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(connection_scope, access_surface, session_id)
) STRICT;
INSERT INTO core_state(singleton, current_revision) VALUES (1, 0);
`;

interface SchemaRow {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

function schemaFingerprint(database: Database.Database): string {
  const rows = database.prepare(`
    SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all() as SchemaRow[];
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function expectedFingerprint(sql: string): string {
  const database = new Database(':memory:');
  try {
    database.exec(sql);
    return schemaFingerprint(database);
  } finally {
    database.close();
  }
}

const CURRENT_SCHEMA_FINGERPRINT = expectedFingerprint(CURRENT_SCHEMA_SQL);

function assertFingerprint(database: Database.Database, expected: string): void {
  if (schemaFingerprint(database) !== expected) {
    throw new Error('Core metadata schema is incompatible');
  }
}

export function initializeRuntimeMetadataSchema(
  database: Database.Database,
  fresh: boolean,
): void {
  if (fresh) {
    database.transaction(() => {
      database.exec(CURRENT_SCHEMA_SQL);
      database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    })();
  }

  const version = database.pragma('user_version', { simple: true }) as number;
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error('Core metadata schema is incompatible');
  }
  assertFingerprint(database, CURRENT_SCHEMA_FINGERPRINT);
}
