CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  title         TEXT NOT NULL,
  lifecycle     TEXT NOT NULL,
  activity      TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  ended_at      INTEGER,
  archived_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_lifecycle ON sessions(lifecycle);
CREATE INDEX IF NOT EXISTS idx_sessions_last_event ON sessions(last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS file_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  before_blob   TEXT,
  after_blob    TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tool_call_id  TEXT,
  ts            INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(file_path);

CREATE TABLE IF NOT EXISTS summaries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id, ts DESC);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
