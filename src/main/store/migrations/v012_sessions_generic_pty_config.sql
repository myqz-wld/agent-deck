-- R4·F2：generic-pty / aider session 的 spawn config 持久化。
--
-- 字段值：JSON.stringify(GenericPtyConfig) | NULL。
-- - generic-pty / aider adapter 的 createSession 落库时写入；resume 时读回 spawn 同 config
-- - claude-code / codex-cli adapter 该字段始终 NULL（不读不写，与 codex_sandbox 同模式）
--
-- 与 v008 codex_sandbox 同款 ALTER TABLE 加列模式（非 NOT NULL，旧行兼容）。
ALTER TABLE sessions ADD COLUMN generic_pty_config TEXT;
