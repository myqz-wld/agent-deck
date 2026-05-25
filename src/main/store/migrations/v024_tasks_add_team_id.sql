-- plan task-team-id-restore-20260525 Step A1 — task 表恢复 team_id 字段(nullable)
--
-- v023 (task-mcp-owner-session-id-rewrite-20260521) follow-up：v023 把 team 从 stored
-- 改成 derived(reverse join sessions → agent_deck_team_members 算 team scope)消灭
-- global task 累积主目标达成,但 lead 多 team 时 derived 算法失真 → lead 在 team A
-- 创建的 task 被 team B 的 teammate 通过 owner-derived reverse join 看到(plan §起源)。
--
-- 修法核心(plan §设计决策 D1-D8):
-- - tasks 表加 team_id TEXT NULL REFERENCES agent_deck_teams(id) ON DELETE SET NULL
-- - team_id != null = team-bound task,可见性 / 写权限按 team 严格隔离(D3)
-- - team_id IS NULL = personal task(first-class 用例,无 team caller 也能用 task — RFC R1.Q1)
-- - task_create 不传 team_id = personal(D2,handler 不自动闭包)
-- - hand_off team_task_policy 三态(D4):clear-team / preserve-team / skip
-- - task_list 加 team_id_filter arg(D5)
-- - migration 保留老数据(D6):ALTER TABLE ADD COLUMN,老 task team_id 自动 null 变 personal
-- - UI 团队面板按 team_id 严格过滤(D7)
-- - task_get external 改 deny external(D8,与 task_create/update/delete 对称)
--
-- 不复活 global task 累积(plan §不变量 4):owner_session_id NOT NULL 兜底 GC 不变,
-- team 硬删时 task.team_id SET NULL 退化为 personal task,仍挂 owner_session_id 名下,
-- 等 owner archive → LifecycleScheduler.historyRetentionDays TTL GC → CASCADE 删 task。
-- 与 v007 根本差别:owner_session_id NOT NULL 仍兜底 GC,team_id NULL 不再是「累积入口」。
--
-- 模板来源:1:1 复用 v011_tasks_team_id.sql(SQLite ALTER ADD COLUMN REFERENCES 合法,
-- v011 + v009_mcp_spawn_chain.sql 已 production 实证,Round 1 HIGH-1 双方独立 sqlite3
-- :memory: PRAGMA foreign_key_list 验证)。
--
-- ON DELETE SET NULL:
-- 用户显式 hardDeleteTeam(极少见)触发 ON DELETE CASCADE 删 messages / members,但 tasks
-- 不级联删 — 历史 task 退化为 personal task(team_id 置 NULL)归 owner_session_id 所有,
-- 等 owner archive 后 CASCADE 删。

ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE SET NULL;

-- 部分索引:跟 v011 同款思路 — 绝大多数 team task 走 team_id 过滤(D5/D7 严格按 team_id
-- 过滤路径),personal task(team_id IS NULL)走 owner_session_id 过滤(已 idx_tasks_owner_session_id
-- 加速)。team_id IS NULL 时部分索引零浪费。
CREATE INDEX IF NOT EXISTS idx_tasks_team_id
  ON tasks(team_id) WHERE team_id IS NOT NULL;
