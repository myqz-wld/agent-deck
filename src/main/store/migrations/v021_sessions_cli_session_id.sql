-- plan reverse-rename-sid-stability-20260520 §A.1: 加 sessions.cli_session_id 列 + backfill + 唯一索引
--
-- 设计动机:reverse rename 让 sessions.id 对外稳定 + 引入 cli_session_id 列承载 CLI thread 当前 sid。
-- 详细设计见 plan §设计决策 D1 (RFC R1-Q1) + §不变量 1-5。
--
-- 字段语义:
-- - cli_session_id TEXT NULL = CLI 当前 thread sid(SDK / CLI 维度)
-- - 与 sessions.id (应用稳定身份)正交 — sessions.id 永不变,cli_session_id 6 处反向 rename 路径下可变
-- - jsonl 路径用 cli_session_id 命名 (~/.claude/projects/<encoded-cwd>/<cli_session_id>.jsonl,spike1 §1.2 实证 5/5 sample)
-- - SDK CLI --resume 入参传 cli_session_id (spike1 §1.1 SDK sdk.mjs `if(k)i.push("--resume",k)` verbatim 透传)
--
-- backfill:历史 row 的 cli_session_id == sessions.id (反向 rename 修法落地前 sessions.id 即 CLI 当前 sid 一份),
--   一次性 UPDATE 让所有现存 row cli_session_id 列填 id 值,与 v021 migration 落地后 ensure() / upsert() 默认行为一致。
-- 无 backfill 等价 NULL → 反查路径走 fallback 不强假设 NOT NULL (D4 cli_session_id 列允许 NULL 边角)。
--
-- 唯一索引:`CREATE UNIQUE INDEX ... ON sessions(cli_session_id)`,SQLite 默认 NULL 允许多行 (treat NULL as distinct),
-- 非空必唯一保 findByCliSessionId 反查 O(log N) (manager-ingest-pipeline 入口高频调用)。
--
-- 幂等性:SQLite ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS,SQL 级**不**幂等(第二次执行抛 dup column)。
-- migration runner 用 PRAGMA user_version 版本号追踪 (db.ts:25-36),v021 仅在 user_version < 21 时执行一次,
-- 执行后 user_version 写为 21 后续启动跳过。生产场景幂等。
ALTER TABLE sessions ADD COLUMN cli_session_id TEXT DEFAULT NULL;

-- 一次性 backfill:历史 row 全部 cli_session_id = id(反向 rename 落地前两者相等)
UPDATE sessions SET cli_session_id = id WHERE cli_session_id IS NULL;

-- 反查路径 O(log N) 唯一索引(允许多 NULL,非空唯一)
CREATE UNIQUE INDEX idx_sessions_cli_session_id ON sessions(cli_session_id);
