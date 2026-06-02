-- v030 — agent_deck_messages 索引补全（plan message-retention-and-index-20260602）
--
-- 关联 issue 7dcb0676（REVIEW_100 follow-up）：teamless DM（v027 team_id 可空）放大
-- agent_deck_messages 表两个 pre-existing 问题：
--   ① listBySession 的 `WHERE from_session_id=? OR to_session_id=?` 无可用索引 → 全表 SCAN
--      + TEMP B-TREE（单 session 面板尾延迟随全局表规模增长）。
--   ② retention GC（MessageLifecycleScheduler）按 `status IN (terminal) AND sent_at < ?` 删超期
--      消息，需可索引谓词才能 LIMIT early-stop 守住 500 分批主线程预算。
--
-- 本 migration **纯加索引，不动表结构**（不加 FK、不重建表）——规避 v027 自引用 FK 整表重建
-- 陷阱（reply_to_message_id 自引用 FK 在整表重建时静默 null，详 v027 注释）。CREATE INDEX
-- 不触发任何 cascade。from/to_session_id 故意无 FK（v010 注释：允许 closed/deleted sender
-- 留痕），本 migration 不改变这一设计。
--
-- 三索引设计（Deep-Review R1/R2 异构对抗实证，spike-reports/spike1-explain-query-plan.{sql,md,log}）：

-- ① + ② listBySession UNION ALL 重写两分支（crud.ts）：
--    SELECT ... WHERE from_session_id=? / WHERE to_session_id=? AND from_session_id<>?
--    各走一索引，(session, sent_at DESC) 让子查询沿索引序，消灭全表 SCAN。
--    v010 从无单列 from 索引 → idx_from 纯增益；idx_to 是单列 idx_messages_to_session_id 的
--    超集前缀（后者保守保留，v030 定调纯加不删存量）。
CREATE INDEX IF NOT EXISTS idx_messages_from_session_sent_at
  ON agent_deck_messages(from_session_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to_session_sent_at
  ON agent_deck_messages(to_session_id, sent_at DESC);

-- ③ GC partial index（Deep-Review R1 codex HIGH-1 实测修订）：必须 partial (sent_at)
--    WHERE status IN (terminal)，**不是** (status, sent_at) 复合索引。
--    复合索引下 `status IN (3值)` 跨 3 段无全局 sent_at 序 → ORDER BY sent_at LIMIT 500 仍
--    USE TEMP B-TREE 全排 backlog（O(N log N) per tick，catch-up 每轮重排）破 500 预算。
--    partial 把 terminal 行收敛进单一 B-tree 段，sent_at 直接有序 → LIMIT 500 沿索引早停无 temp sort。
--    ⚠️ GC 查询（gc.ts listExpiredForGc）的 `status IN (...)` 必须与本 WHERE **字面同序同值**
--    才命中部分索引（codex R2 实测：参数化 / 单值 / 顺序不同均不命中）。
CREATE INDEX IF NOT EXISTS idx_messages_terminal_sent_at
  ON agent_deck_messages(sent_at)
  WHERE status IN ('delivered', 'failed', 'cancelled');
