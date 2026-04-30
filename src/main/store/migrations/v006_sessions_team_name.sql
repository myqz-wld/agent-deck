-- Agent Teams 接入：sessions 加 team_name TEXT 列。
-- 应用层标签 + env 触发条件：当 settings.agentTeamsEnabled=true 且 team_name 非空时，
-- spawn SDK 子进程注入 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 启用 Claude Code 的 agent
-- teams 实验特性。team 元信息（成员 / shared task list）权威源是 Claude 维护的
-- ~/.claude/teams/<name>/ 与 ~/.claude/tasks/<name>/ 目录，不在 DB 复刻。
-- 仅 SDK 通道（claude-code adapter）会写非 NULL；CLI / hook / 占位 adapter 永远 NULL。
ALTER TABLE sessions ADD COLUMN team_name TEXT;

-- 部分索引：仅索引非 NULL 行，绝大多数会话不属于 team 时零浪费。
-- M2 用作 distinctTeamNames / findByTeamName 的回表索引。
CREATE INDEX IF NOT EXISTS idx_sessions_team_name
  ON sessions(team_name) WHERE team_name IS NOT NULL;
