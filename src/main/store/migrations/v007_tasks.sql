-- Task Manager: 结构化任务管理 in-process MCP server 的持久层。
-- 为「Claude Agent SDK 没有原生任务管理工具」而建：补一套 task_create / task_list /
-- task_get / task_update / task_delete 5 个 in-process MCP tools，让 SDK Agent 之间
-- 可以协作管理结构化任务。
--
-- 与 sessions.team_name 同语义（v006 引入）：team_name 是纯应用层标签，team 在 fs
-- 被 Claude 删掉后不联动删 task（保留为 orphan 任务，UI 后续可标灰）。这与 sessions
-- 也不会因为 team 在 fs 被删而联动删一致。
--
-- 与 ~/.claude/tasks/<team>/<list>.md 互补：那是 Claude 自己用自然语言维护的
-- markdown task list（团队成员之间协作），本 tasks 表是结构化、可被 MCP 工具精确
-- 调用的另一套 store。两套并行，互不覆盖。
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                     -- UUID v4 (crypto.randomUUID)
  team_name TEXT,                          -- NULL = 全局任务；非 NULL = 该 team 范围
  subject TEXT NOT NULL,                   -- 1-200 char (tool 层 zod 校验)
  description TEXT,                        -- ≤2000 char (tool 层 zod 校验)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|active|completed|blocked|abandoned
  active_form TEXT,                        -- 当前认领 agent 名（兼容 Claude Code TaskUpdate）
  priority INTEGER NOT NULL DEFAULT 5,     -- 0-10
  blocks TEXT NOT NULL DEFAULT '[]',       -- JSON string of task id[]
  blocked_by TEXT NOT NULL DEFAULT '[]',   -- JSON string of task id[]
  labels TEXT NOT NULL DEFAULT '[]',       -- JSON string of string[]
  created_at TEXT NOT NULL,                -- ISO8601
  updated_at TEXT NOT NULL                 -- ISO8601
);

-- 部分索引：跟 v006 sessions.team_name 同款思路 —— 绝大多数任务可能是全局
-- (team_name NULL) 时零浪费。
CREATE INDEX IF NOT EXISTS idx_tasks_team_name
  ON tasks(team_name) WHERE team_name IS NOT NULL;

-- list 默认按 status 过滤 + updated_at 倒序，两个常用查询路径都给 b-tree 加速。
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
