-- 把「归档」从 lifecycle 拆出来。lifecycle 只保留 active/dormant/closed；
-- 是否归档由 archived_at IS NOT NULL 决定。把现有 lifecycle='archived' 行改为 closed
-- 并补 archived_at（若 NULL，用 ended_at 或 last_event_at 兜底），以保留归档语义。
UPDATE sessions
   SET archived_at = COALESCE(archived_at, ended_at, last_event_at),
       lifecycle = 'closed'
 WHERE lifecycle = 'archived';
