import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let dbInstance: Database.Database | null = null;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1_INIT = `
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
`;

const V2_ADD_SOURCE = `
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'cli';
`;

// V3: 把「归档」从 lifecycle 拆出来。lifecycle 只保留 active/dormant/closed；
// 是否归档由 archived_at IS NOT NULL 决定。把现有 lifecycle='archived' 行改为 closed
// 并补 archived_at（若 NULL，用 ended_at 或 last_event_at 兜底），以保留归档语义。
const V3_SPLIT_ARCHIVE = `
UPDATE sessions
   SET archived_at = COALESCE(archived_at, ended_at, last_event_at),
       lifecycle = 'closed'
 WHERE lifecycle = 'archived';
`;

// V4: 持久化 SDK 通道的 permission_mode（用户上次主动选过的）。SDK Query 自身有运行时
// 状态但不暴露 getter，DB 列让 UI 切回 detail / 恢复会话时能还原下拉。
// CLI 通道不写这列，永远 NULL。
const V4_ADD_PERMISSION_MODE = `
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
`;

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: V1_INIT },
  { version: 2, name: 'sessions_source', sql: V2_ADD_SOURCE },
  { version: 3, name: 'split_archive_from_lifecycle', sql: V3_SPLIT_ARCHIVE },
  { version: 4, name: 'sessions_permission_mode', sql: V4_ADD_PERMISSION_MODE },
];

export function initDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const userDataDir = app.getPath('userData');
  mkdirSync(userDataDir, { recursive: true });
  const dbPath = join(userDataDir, 'agent-deck.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const userVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > userVersion);

  if (pending.length > 0) {
    const tx = db.transaction(() => {
      for (const m of pending) {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
        console.log(`[db] migrated to v${m.version} (${m.name})`);
      }
    });
    tx();
  }

  dbInstance = db;
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
