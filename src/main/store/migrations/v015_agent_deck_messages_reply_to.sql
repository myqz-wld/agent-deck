-- plan team-cohesion-fix-20260513 Phase B Step B1 — messages 表加 reply_to_message_id
--
-- 让 send_message / reply_message / wait_reply 三 tool 组合（D3 方案 D 收口）能建立对话链：
-- - send_message(text, reply_to_message_id?) — 普通发 / 回复某条
-- - reply_message(reply_to_message_id, text) — 语法糖：自动算 to_session_id (从原 msg 的 from_session_id) + team_id (复用)
-- - wait_reply(message_id, nudge_text?, timeout_ms?) — 等某条 msg 的 reply (DB query: reply_to_message_id=?)，
--   等久了塞 nudge_text 作"催回复"
--
-- 与老 wait_reply (事件流投影) 完全不同语义：新 wait_reply 直接 query messages 表，
-- 不依赖 collected events / promise sharing / baseline_ts race 防御。

-- ────────────────────────────────────────────────────────────────────────────
-- 加 reply_to_message_id 列：可空（普通 send 时为 NULL）；指向另一条 messages.id 建立对话链
-- ON DELETE SET NULL：原 msg 被 hardDelete 时 reply 仍可读，只是关联断开
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE agent_deck_messages
  ADD COLUMN reply_to_message_id TEXT
  REFERENCES agent_deck_messages(id) ON DELETE SET NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 部分索引：wait_reply 主查询 `WHERE reply_to_message_id = ?`，绝大多数 msg 不是 reply（NULL）
-- 时部分索引零浪费（与 v007/v009/v011 部分索引同款思路）
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON agent_deck_messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
