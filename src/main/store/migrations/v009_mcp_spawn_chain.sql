-- B'0 ADR §6.5.1 / R2 阶段：sessions 加 spawned_by + spawn_depth 列，
-- 用于 Agent Deck MCP server 的防递归 4 条规则（depth 上限 / per-parent fan-out /
-- cwd realpath 整链回溯）。
--
-- 字段语义：
-- - spawned_by：父 session id；NULL = 顶层 session（用户 IPC / CLI 直接起 / 或 R2 之前老数据）
-- - spawn_depth：当前 session 在 spawn 链上的层数；0 = 顶层（默认值），子 = parent.spawn_depth + 1
--
-- ON DELETE SET NULL：在 §3.5 改为 lifecycle=closed 而非 hard-delete 后，理论上永远
-- 不触发（保留作为兜底）。万一未来真删 session，子表 spawned_by 自动断链而非保留
-- 悬挂引用导致 join 失效。
--
-- 兼容性：
-- - 老 sessions（v009 之前的）spawned_by 全 NULL / spawn_depth 全 0 → 行为退化「无父 + 顶层」，
--   与 R2 之前应用入口（IPC / CLI）创建的 session 语义一致
-- - 任何新起 session（含 IPC / CLI / MCP spawn_session）都从 0 起；MCP spawn_session
--   handler 会调 sessionRepo.setSpawnLink(newId, parentId, depth) 覆盖
--
-- index：spawned_by 用于 §6.4 per-parent fan-out 反查（O(N) 扫表 → O(log N)）

ALTER TABLE sessions ADD COLUMN spawned_by TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_sessions_spawned_by ON sessions(spawned_by);
