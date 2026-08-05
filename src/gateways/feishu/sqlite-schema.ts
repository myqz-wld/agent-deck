import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { FeishuGatewayError } from '@gateways/im';

export const FEISHU_METADATA_SCHEMA_VERSION = 2;
const SCHEMA_FINGERPRINT = 'f31d64f0d2d9f7de24b6f47d346efeb1a8d3c83a7c8380420a527ab0809e0447';

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  credentials: [
    'app_id', 'tenant_key', 'open_id', 'instance_id', 'credential_id', 'topology',
    'status', 'authority',
  ],
  contexts: [
    'instance_id', 'credential_id', 'chat_id', 'open_id', 'active_session_id', 'updated_at',
    'chat_type',
  ],
  subscriptions: [
    'instance_id', 'credential_id', 'chat_id', 'session_id', 'status', 'updated_at',
  ],
  deliveries: [
    'instance_id', 'event_id', 'credential_id', 'chat_id', 'status', 'attempts', 'phase',
    'transport_safety', 'attempt_deadline_at', 'updated_at',
    'transport_idempotency_expires_at',
  ],
  cursors: ['instance_id', 'credential_id', 'chat_id', 'revision', 'updated_at'],
  health: [
    'instance_id', 'state', 'generation', 'reconnect_attempts', 'last_error_code', 'updated_at',
  ],
});

const SCHEMA_V1 = `
CREATE TABLE credentials (
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  open_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  topology TEXT NOT NULL CHECK (topology IN ('relay', 'server-core')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  authority TEXT NOT NULL CHECK (authority = 'owner-equivalent'),
  PRIMARY KEY (app_id, tenant_key, open_id),
  UNIQUE (instance_id, credential_id)
) STRICT;
CREATE TABLE contexts (
  instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  active_session_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, credential_id, chat_id),
  FOREIGN KEY (instance_id, credential_id)
    REFERENCES credentials(instance_id, credential_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE subscriptions (
  instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, credential_id, chat_id, session_id),
  FOREIGN KEY (instance_id, credential_id, chat_id)
    REFERENCES contexts(instance_id, credential_id, chat_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE deliveries (
  instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('deduplicated', 'exhausted', 'failed', 'pending', 'reconciling', 'sent')
  ),
  attempts INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('core', 'pre-transport', 'transport-invoked')),
  transport_safety TEXT CHECK (transport_safety IN ('safe', 'unknown')),
  attempt_deadline_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, event_id)
) STRICT;
CREATE TABLE cursors (
  instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, credential_id, chat_id),
  FOREIGN KEY (instance_id, credential_id, chat_id)
    REFERENCES contexts(instance_id, credential_id, chat_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE health (
  instance_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('connected', 'failed', 'reconnecting', 'starting', 'stopped')),
  generation INTEGER NOT NULL,
  reconnect_attempts INTEGER NOT NULL,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version = 1;
`;

const MIGRATION_V2 = `
ALTER TABLE contexts ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'group'
  CHECK (chat_type IN ('group', 'p2p'));
ALTER TABLE deliveries ADD COLUMN transport_idempotency_expires_at INTEGER
  CHECK (transport_idempotency_expires_at IS NULL OR transport_idempotency_expires_at >= 0);
UPDATE deliveries SET transport_idempotency_expires_at = updated_at
  WHERE transport_safety = 'safe';
PRAGMA user_version = 2;
`;

function fail(): never {
  throw new FeishuGatewayError(
    'invalid_configuration',
    'Feishu metadata database schema could not be verified',
  );
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

function verifyExactSchema(db: Database.Database): void {
  const names = tableNames(db);
  const expected = Object.keys(TABLE_COLUMNS).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) fail();
  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name);
    if (
      actual.length !== columns.length ||
      actual.some((column, index) => column !== columns[index])
    ) fail();
  }
  const unexpected = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type IN ('trigger', 'view')
       OR (type = 'index' AND name NOT LIKE 'sqlite_autoindex_%')
    LIMIT 1
  `).get();
  if (unexpected) fail();
  const definitions = (db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>)
    .map((entry) => ({
      ...entry,
      sql: entry.sql?.replace(/\s+/gu, ' ').trim() ?? null,
    }));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(definitions), 'utf8')
    .digest('hex');
  if (fingerprint !== SCHEMA_FINGERPRINT) fail();
}

export function initializeFeishuMetadataSchema(db: Database.Database): void {
  let version = db.pragma('user_version', { simple: true }) as number;
  if (version === 0) {
    if (tableNames(db).length !== 0) fail();
    try {
      db.exec(`BEGIN IMMEDIATE;${SCHEMA_V1}COMMIT;`);
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original fixed schema failure is authoritative.
      }
      fail();
    }
    version = 1;
  }
  if (version === 1) {
    try {
      db.exec(`BEGIN IMMEDIATE;${MIGRATION_V2}COMMIT;`);
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original fixed migration failure is authoritative.
      }
      fail();
    }
    version = 2;
  }
  if (version !== FEISHU_METADATA_SCHEMA_VERSION) {
    fail();
  }
  verifyExactSchema(db);
}

export function feishuMetadataColumns(): Readonly<Record<string, readonly string[]>> {
  return TABLE_COLUMNS;
}
