-- 模拟 db.ts:20-26 真实 pragma 环境
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = ON;

-- ── v010 + v015 原始 schema (team_id NOT NULL + 自引用 reply_to_message_id FK) ──
CREATE TABLE agent_deck_teams (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  archived_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, archived_at INTEGER);
CREATE TABLE agent_deck_messages (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL, to_session_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 102400),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivering','delivered','failed','cancelled')),
  status_reason TEXT, sent_at INTEGER NOT NULL, delivered_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, delivering_since INTEGER,
  reply_to_message_id TEXT REFERENCES agent_deck_messages(id) ON DELETE SET NULL
);
CREATE INDEX idx_messages_status_last_attempt ON agent_deck_messages(status, last_attempt_at);
CREATE INDEX idx_messages_team_id_sent_at ON agent_deck_messages(team_id, sent_at DESC);
CREATE INDEX idx_messages_to_session_id ON agent_deck_messages(to_session_id);
CREATE INDEX idx_messages_to_session_pending ON agent_deck_messages(to_session_id, status) WHERE status IN ('pending','delivering');
CREATE INDEX idx_messages_reply_to ON agent_deck_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

INSERT INTO agent_deck_teams (id,name,created_at) VALUES ('t1','team-a',1);
INSERT INTO sessions (id) VALUES ('s1'),('s2');
INSERT INTO agent_deck_messages (id,team_id,from_session_id,to_session_id,body,sent_at) VALUES ('m1','t1','s1','s2','hello',100);
INSERT INTO agent_deck_messages (id,team_id,from_session_id,to_session_id,body,sent_at,reply_to_message_id) VALUES ('m2','t1','s2','s1','re:hello',200,'m1');
SELECT 'SETUP: rows=' || count(*) FROM agent_deck_messages;

-- ── 模拟 db.transaction(): BEGIN ... COMMIT, foreign_keys 保持 ON (事务内 pragma 改不了) ──
BEGIN;
CREATE TABLE agent_deck_messages_new (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE CASCADE,   -- 放松 NOT NULL
  from_session_id TEXT NOT NULL, to_session_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 102400),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivering','delivered','failed','cancelled')),
  status_reason TEXT, sent_at INTEGER NOT NULL, delivered_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, delivering_since INTEGER,
  reply_to_message_id TEXT REFERENCES agent_deck_messages(id) ON DELETE SET NULL
);
INSERT INTO agent_deck_messages_new
  SELECT id,team_id,from_session_id,to_session_id,body,status,status_reason,sent_at,delivered_at,attempt_count,last_attempt_at,delivering_since,reply_to_message_id
  FROM agent_deck_messages;
DROP TABLE agent_deck_messages;
ALTER TABLE agent_deck_messages_new RENAME TO agent_deck_messages;
CREATE INDEX idx_messages_status_last_attempt ON agent_deck_messages(status, last_attempt_at);
CREATE INDEX idx_messages_team_id_sent_at ON agent_deck_messages(team_id, sent_at DESC);
CREATE INDEX idx_messages_to_session_id ON agent_deck_messages(to_session_id);
CREATE INDEX idx_messages_to_session_pending ON agent_deck_messages(to_session_id, status) WHERE status IN ('pending','delivering');
CREATE INDEX idx_messages_reply_to ON agent_deck_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
COMMIT;
SELECT 'CASE-A REBUILD: OK (committed, FK stayed ON)';

-- 验证 1: 自引用 FK 数据保留
SELECT 'VERIFY self-FK preserved: ' || CASE WHEN reply_to_message_id='m1' THEN 'PASS' ELSE 'FAIL' END FROM agent_deck_messages WHERE id='m2';
-- 验证 2: foreign_key_check 无违规
SELECT 'VERIFY foreign_key_check: ' || CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM pragma_foreign_key_check('agent_deck_messages');
-- 验证 3: 能插 team_id=NULL teamless DM
INSERT INTO agent_deck_messages (id,team_id,from_session_id,to_session_id,body,sent_at) VALUES ('m3',NULL,'s1','s2','teamless',300);
SELECT 'VERIFY teamless insert: ' || CASE WHEN team_id IS NULL THEN 'PASS' ELSE 'FAIL' END FROM agent_deck_messages WHERE id='m3';
