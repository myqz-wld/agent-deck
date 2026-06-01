-- v027 — agent_deck_messages.team_id NOT NULL → nullable（plan teamless-dm-20260601）
--
-- 目标：解除 send_message 的「双方必须共享 active team」限制，让任意两个 session 互发
-- teamless DM。teamless 消息以 team_id=NULL 落库；team 消息行为不变。
--
-- 为何整表重建：SQLite 不支持 ALTER COLUMN 去 NOT NULL，必须 recreate table（v014 DROP
-- COLUMN / v017 改 FK 同款 12-step 流程）。
--
-- ⚠️ 自引用 FK 陷阱（spike 实证，详 ref/plans/teamless-dm-20260601/spike-reports/
-- spike1-migration-self-ref-fk.md）：agent_deck_messages 有自引用 FK
-- `reply_to_message_id REFERENCES agent_deck_messages(id) ON DELETE SET NULL`（v015）。
-- v017-style「建 _new 临时表 + INSERT FROM old + DROP old + RENAME _new」在
-- foreign_keys=ON（db.ts:21）下会**静默 null 掉所有 reply_to_message_id**：DROP old 对
-- 旧表每行做隐式 DELETE，此刻 _new 表的自引用 FK 按表名解析仍指向正被 DROP 的旧表 →
-- 触发 _new 里引用它的 reply 行 ON DELETE SET NULL。spike 实测 `after-copy=m1` →
-- `after-DROP=NULL`，且 foreign_key_check 反而 PASS（null 是合法值，静态检查抓不到）。
-- v017 没踩此坑是因为 member 表无人引用；messages 表引用自己是质的区别。
-- `PRAGMA defer_foreign_keys` 不救（只推迟约束检查，不推迟 cascade 动作）。
--
-- ✅ 正确手法 = rename-old-first（spike FIX-3 实证 PASS，行序无关）：先把旧表 RENAME 成
-- _old，再用**最终名**建新表（自引用 FK 解析到自己），INSERT FROM _old，最后 DROP _old
-- （无人引用 _old → 零 cascade，reply chain 完整保留）。
--
-- 本 migration 在 db.ts 的 db.transaction(() => db.exec) + foreign_keys=ON 内跑，与 spike
-- 模拟环境一致。defer_foreign_keys=ON 为防御性保留（spike 证非必需但零成本，COMMIT 时自动复位）。

PRAGMA defer_foreign_keys=ON;

-- Step 1: 旧表改名（保留全部数据行；自引用 FK 此刻仍指向 "agent_deck_messages" 这个名字）
ALTER TABLE agent_deck_messages RENAME TO agent_deck_messages_old;

-- Step 2: 用最终名建新表 —— 与 v010 + v015 byte-level 一致，**仅 team_id 去掉 NOT NULL**。
-- 自引用 FK reply_to_message_id 解析到「自己」（本表），不指向 _old。
CREATE TABLE agent_deck_messages (
  id              TEXT PRIMARY KEY NOT NULL,
  team_id         TEXT REFERENCES agent_deck_teams(id) ON DELETE CASCADE,  -- v027: 去 NOT NULL（teamless DM 用 NULL）
  from_session_id TEXT NOT NULL,
  to_session_id   TEXT NOT NULL,
  body            TEXT NOT NULL CHECK (length(body) <= 102400),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
  status_reason   TEXT,
  sent_at         INTEGER NOT NULL,
  delivered_at    INTEGER,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  delivering_since INTEGER,
  reply_to_message_id TEXT REFERENCES agent_deck_messages(id) ON DELETE SET NULL
);

-- Step 3: 搬数据。13 列显式列出（与 crud.ts insert 列序一致；不用 SELECT * 防列序错位）。
INSERT INTO agent_deck_messages
  (id, team_id, from_session_id, to_session_id, body, status, status_reason,
   sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
SELECT
   id, team_id, from_session_id, to_session_id, body, status, status_reason,
   sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id
FROM agent_deck_messages_old;

-- Step 4: 删旧表（无人引用 _old → 零 cascade，reply chain 保留）
DROP TABLE agent_deck_messages_old;

-- Step 5: 重建全部 5 个 index（v010 的 4 个 + v015 的 reply_to 部分索引）。
-- DROP TABLE 已带走旧表 index，必须全部重建。
CREATE INDEX IF NOT EXISTS idx_messages_status_last_attempt
  ON agent_deck_messages(status, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_messages_team_id_sent_at
  ON agent_deck_messages(team_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to_session_id
  ON agent_deck_messages(to_session_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_session_pending
  ON agent_deck_messages(to_session_id, status) WHERE status IN ('pending','delivering');
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON agent_deck_messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
