// Exact previously deployed v4 schema, frozen for migration acceptance.
export const FEISHU_SCHEMA_V4 = `
CREATE TABLE credentials (
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  open_id TEXT,
  instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  connection_scope TEXT NOT NULL,
  topology TEXT NOT NULL CHECK (topology IN ('relay', 'full')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  authority TEXT NOT NULL CHECK (authority = 'owner-equivalent'),
  PRIMARY KEY (instance_id, credential_id),
  UNIQUE (app_id, tenant_key, open_id),
  UNIQUE (instance_id, connection_scope)
) STRICT;
CREATE TABLE contexts (
  instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  active_session_id TEXT,
  updated_at INTEGER NOT NULL,
  chat_type TEXT NOT NULL CHECK (chat_type IN ('group', 'p2p')),
  PRIMARY KEY (instance_id, credential_id, chat_id),
  FOREIGN KEY (instance_id, credential_id)
    REFERENCES credentials(instance_id, credential_id) ON UPDATE CASCADE ON DELETE CASCADE
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
    REFERENCES contexts(instance_id, credential_id, chat_id) ON UPDATE CASCADE ON DELETE CASCADE
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
  transport_idempotency_expires_at INTEGER
    CHECK (transport_idempotency_expires_at IS NULL OR transport_idempotency_expires_at >= 0),
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
    REFERENCES contexts(instance_id, credential_id, chat_id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
CREATE TABLE health (
  instance_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('connected', 'failed', 'reconnecting', 'starting', 'stopped')),
  generation INTEGER NOT NULL,
  reconnect_attempts INTEGER NOT NULL,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE pairing_codes (
  instance_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_event_id TEXT,
  PRIMARY KEY (instance_id, code_id),
  UNIQUE (instance_id, code_hash)
) STRICT;
CREATE TABLE pairing_requests (
  instance_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  open_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'expired', 'rejected')),
  credential_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (instance_id, request_id),
  UNIQUE (instance_id, code_id),
  FOREIGN KEY (instance_id, code_id)
    REFERENCES pairing_codes(instance_id, code_id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE delete_confirmations (
  instance_id TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expected_archived INTEGER NOT NULL CHECK (expected_archived IN (0, 1)),
  expected_updated_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'completed', 'expired')),
  claim_event_id TEXT,
  claim_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, confirmation_id),
  UNIQUE (instance_id, token_hash),
  FOREIGN KEY (instance_id, credential_id)
    REFERENCES credentials(instance_id, credential_id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
PRAGMA user_version = 4;
`;
