-- spike1 runner — agent_deck_messages listBySession 全表扫描 + UNION ALL 双索引重写实测
-- plan message-retention-and-index-20260602
--
-- 跑法：sqlite3 :memory: < spike1-explain-query-plan.sql  （或落临时 db）
-- 目的：实证 issue 7dcb0676 两条结论（+ Deep-Review R1/R2 修订）
--   (1) 当前 listBySession 的 `WHERE from=? OR to=?` 走 SCAN 全表 + TEMP B-TREE
--   (2) 双索引 (from,sent_at DESC)+(to,sent_at DESC) + UNION ALL 重写 → 双 SEARCH USING INDEX
--       且结果与 baseline OR 查询 100% 一致（含同毫秒 rowid 二级定序 / status filter / 分页 offset）
--   (3) self-msg（from==to）正常 insert 不存在（throw）→ 无重复；但 rename collision 可造 self-row
--       → UNION ALL 第二分支必须加 `from_session_id <> ?` guard 防重复（Review R1 codex HIGH-2）
--   (4) GC 查询必须用 partial `(sent_at) WHERE status IN (terminal)` 索引才能 LIMIT early-stop；
--       status-first `(status,sent_at)` 仍 USE TEMP B-TREE 全排 backlog 破 500 预算（Review R1 codex HIGH-1）

PRAGMA foreign_keys=ON;

-- ── 复刻 v027 schema（team_id nullable）+ v010/v015 的 5 索引 ──
CREATE TABLE agent_deck_teams (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  archived_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE agent_deck_messages (
  id              TEXT PRIMARY KEY NOT NULL,
  team_id         TEXT REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL,
  to_session_id   TEXT NOT NULL,
  body            TEXT NOT NULL CHECK (length(body) <= 102400),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','delivering','delivered','failed','cancelled')),
  status_reason   TEXT,
  sent_at         INTEGER NOT NULL,
  delivered_at    INTEGER,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  delivering_since INTEGER,
  reply_to_message_id TEXT REFERENCES agent_deck_messages(id) ON DELETE SET NULL
);
CREATE INDEX idx_messages_status_last_attempt ON agent_deck_messages(status, last_attempt_at);
CREATE INDEX idx_messages_team_id_sent_at ON agent_deck_messages(team_id, sent_at DESC);
CREATE INDEX idx_messages_to_session_id ON agent_deck_messages(to_session_id);
CREATE INDEX idx_messages_to_session_pending ON agent_deck_messages(to_session_id, status) WHERE status IN ('pending','delivering');
CREATE INDEX idx_messages_reply_to ON agent_deck_messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

-- ── 灌 5000 行模拟数据（50 个 session，from/to 错位避免 self-msg）──
WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 5000)
INSERT INTO agent_deck_messages (id, team_id, from_session_id, to_session_id, body, status, sent_at)
SELECT 'm'||i, NULL, 's'||(i%50), 's'||((i+7)%50), 'body'||i, 'delivered', 1700000000000 + i FROM c;
ANALYZE;

.print '===== (1) baseline 当前 OR 查询 EXPLAIN（期望 SCAN + TEMP B-TREE）====='
EXPLAIN QUERY PLAN
SELECT * FROM agent_deck_messages WHERE from_session_id='s3' OR to_session_id='s3'
ORDER BY sent_at DESC, rowid DESC LIMIT 100;

-- ── 加 v029 的 listBySession 双索引（GC 索引留到 (4a)/(4b) 对比段单独建/换）──
CREATE INDEX idx_messages_from_session_sent_at ON agent_deck_messages(from_session_id, sent_at DESC);
CREATE INDEX idx_messages_to_session_sent_at ON agent_deck_messages(to_session_id, sent_at DESC);
ANALYZE;

.print ''
.print '===== (2) UNION ALL 双索引重写 EXPLAIN（期望双 SEARCH USING INDEX，无 SCAN）====='
EXPLAIN QUERY PLAN
SELECT * FROM (
  SELECT *, rowid AS _rid FROM agent_deck_messages WHERE from_session_id='s3'
  UNION ALL
  SELECT *, rowid AS _rid FROM agent_deck_messages WHERE to_session_id='s3' AND from_session_id <> 's3'
) ORDER BY sent_at DESC, _rid DESC LIMIT 100;

.print ''
.print '===== (3a) 正常数据正确性：union_all_cnt == or_cnt（self-msg 不存在 → 无重复）====='
SELECT
  (SELECT COUNT(*) FROM agent_deck_messages WHERE from_session_id='s3' OR to_session_id='s3') AS or_cnt,
  (SELECT COUNT(*) FROM (SELECT id FROM agent_deck_messages WHERE from_session_id='s3'
     UNION ALL SELECT id FROM agent_deck_messages WHERE to_session_id='s3' AND from_session_id <> 's3')) AS union_all_guarded_cnt,
  (SELECT COUNT(*) FROM agent_deck_messages WHERE from_session_id = to_session_id) AS self_rows;

.print ''
.print '===== (3b) self-row guard（Review R1 codex HIGH-2）：rename collision 造 from==to ====='
.print '-- 插一条 self-row（模拟 rename A->B 把 from=A,to=B 变 from=B,to=B）：'
INSERT INTO agent_deck_messages (id,team_id,from_session_id,to_session_id,body,status,sent_at)
  VALUES ('self1', NULL, 'sSELF', 'sSELF', 'rename-collision', 'delivered', 1700000099999);
.print '-- baseline OR（期望 1）/ 无 guard UNION ALL（期望 2 BUG）/ 有 guard（期望 1 FIX）：'
SELECT
  (SELECT COUNT(*) FROM agent_deck_messages WHERE from_session_id='sSELF' OR to_session_id='sSELF') AS or_cnt,
  (SELECT COUNT(*) FROM (SELECT id FROM agent_deck_messages WHERE from_session_id='sSELF'
     UNION ALL SELECT id FROM agent_deck_messages WHERE to_session_id='sSELF')) AS noguard_cnt,
  (SELECT COUNT(*) FROM (SELECT id FROM agent_deck_messages WHERE from_session_id='sSELF'
     UNION ALL SELECT id FROM agent_deck_messages WHERE to_session_id='sSELF' AND from_session_id <> 'sSELF')) AS guarded_cnt;
DELETE FROM agent_deck_messages WHERE id='self1';

.print ''
.print '===== (4a) GC status-first 索引 (status,sent_at)：SEARCH 但仍 TEMP B-TREE（破 500 预算 ❌）====='
CREATE INDEX idx_messages_status_sent_at ON agent_deck_messages(status, sent_at);
ANALYZE;
EXPLAIN QUERY PLAN
SELECT id FROM agent_deck_messages
WHERE status IN ('delivered','failed','cancelled') AND sent_at < 1700000002500
ORDER BY sent_at ASC LIMIT 500;

.print ''
.print '===== (4b) GC partial 索引 (sent_at) WHERE status IN terminal：无 TEMP B-TREE（✅ 正解）====='
DROP INDEX idx_messages_status_sent_at;
CREATE INDEX idx_messages_terminal_sent_at ON agent_deck_messages(sent_at) WHERE status IN ('delivered','failed','cancelled');
ANALYZE;
EXPLAIN QUERY PLAN
SELECT id FROM agent_deck_messages
WHERE status IN ('delivered','failed','cancelled') AND sent_at < 1700000002500
ORDER BY sent_at ASC LIMIT 500;

.print ''
.print '===== (4c) partial index 命中规则（Review R2 codex）：参数化 / 单值 / 顺序不同 不命中 ====='
.print '-- 单值 equality（期望 不命中 partial，走别的索引或 SCAN）：'
EXPLAIN QUERY PLAN
SELECT id FROM agent_deck_messages WHERE status = 'delivered' AND sent_at < 1700000002500 ORDER BY sent_at ASC LIMIT 500;
