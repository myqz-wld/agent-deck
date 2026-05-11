-- R3.E2 / E0 ADR §5.4 — task-manager 迁移到 team_id
--
-- 配套 v010 (agent_deck_teams 三表) 引入：tasks 表加 team_id 列，task-manager 重写
-- closure injection 从 teamNameProvider → teamIdProvider，让多 team / 重名 team 场景下
-- task scope 仍可精确定位（team_name 字符串歧义问题 reviewer codex HIGH-3 + claude MED-9 修法）。
--
-- 兼容性策略：
-- - tasks.team_name (v007) 列保留，新代码不写（写值固定 NULL）
-- - 老 list({teamName}) 入口提供 1 版兼容 helper：lookup agent_deck_teams.name → team_id (active 唯一)
--   下版本（v012）大版本删 tasks.team_name 列
-- - 不做 backfill：老 task 的 team_id 全 NULL；如有需要由 task-manager 重写阶段 lazy 关联
--
-- ON DELETE SET NULL：
-- 用户显式 hardDeleteTeam（极少见）触发 ON DELETE CASCADE 删 messages / members，但 tasks
-- 不级联删 —— 历史 task 保留可读，team_id 置 NULL = "孤儿任务"（UI 标灰，task-repo.list 不
-- 默认拉但显式查 team_id IS NULL 可拉）。

ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE SET NULL;

-- 部分索引：跟 v007 tasks.team_name + v006 sessions.team_name 同款思路 —— 绝大多数老
-- 任务 team_id 是 NULL 时零浪费。
CREATE INDEX IF NOT EXISTS idx_tasks_team_id
  ON tasks(team_id) WHERE team_id IS NOT NULL;
