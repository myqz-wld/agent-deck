-- CHANGELOG_74 Step 1：claude-code OS 沙盒档位 per-session 持久化到 sessions.claude_code_sandbox。
--
-- 与 v008 codex_sandbox 同模式：让用户在 NewSessionDialog 选过的 sandbox 档位重启应用 / resume 后还原，
-- 避免静默被全局 settings.claudeCodeSandbox 默认值覆盖（用户辛苦选过的档位不会丢）。
--
-- 字段值：'off' | 'workspace-write' | 'strict'，与 settings.claudeCodeSandbox union 一致。
--
-- 兼容性：codex / aider / generic-pty 会话该字段始终为 NULL（不读不写）。
ALTER TABLE sessions ADD COLUMN claude_code_sandbox TEXT;
