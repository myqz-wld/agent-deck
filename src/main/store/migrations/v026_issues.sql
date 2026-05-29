-- Issue Tracker: agent 执行问题追踪机制持久层（plan issue-tracker-mcp-20260529 §D9 / D11 / D16）。
--
-- agent 在执行过程中遇到的「需要后续处理的问题」（自己 follow-up / 应用缺陷 / 外部工具 bug
-- / 约定缺漏 / 产品功能建议）通过 mcp tool `report_issue` + `append_issue_context` 上报，
-- 落本表 + UI 顶层 Issues tab 单独可见，用户在 UI 端手动 triage（filter / 改字段 / 软删
-- / 「Resolve in new session」一键 spawn 接力）。
--
-- 关键设计（详 plan §不变量 + §D9-D20）：
-- - **agent 只能写、不能查**：mcp tool 仅暴露 report_issue / append_issue_context 写
--   tool（§不变量 1），UI 端独立 IPC handler 提供读 / 改 / 删通道
-- - **issue 独立生命周期**：source_session_id / resolution_session_id 都 ON DELETE
--   SET NULL（§不变量 2 / §D11），不与 tasks 表 ON DELETE CASCADE 对称 — issue 是面向
--   用户的看板，不能因后台 session GC 而静默消失
-- - **append_issue_context 严格 source-bound**：仅 source caller 同 session 内可
--   append（§不变量 3 / §D10）；跨 session / 跨 caller append 一律 reject
-- - **logs_ref 是定位指针**：JSON `{date, tsRange?, scopes?, note?}` 不存日志体；UI 端按
--   runtime-logging-electron-log-20260529 plan §D2/§D3 拼日志路径自助读
-- - **状态机仅 UI 端人工推进**：open / in-progress / resolved 三态（§D7），agent 永不修改
-- - **append 累积走 issue_appendices 子表**（§不变量 9 / §D16）：不动 issues.description
--   1-2000 char 不变量；append 写独立子表，UI detail 视图按 appendedAt asc 渲染
-- - **GC 双轨**：UI 软删（deleted_at）+ IssueLifecycleScheduler 周期硬删（resolved 超
--   issueResolvedRetentionDays / soft-deleted 超 issueSoftDeletedRetentionDays，§D13）
-- - **DB 命名 snake_case**：与 sessions / agent_deck_teams 表对齐 SQLite 惯例；mcp tool
--   args / TS code 全 camelCase（§D18 + CHANGELOG_177 收口）
-- - **timestamp 用 INTEGER epoch ms**：与 sessions / agent_deck_teams 表一致（§D9 决策）
CREATE TABLE IF NOT EXISTS issues (
  id                     TEXT PRIMARY KEY,                             -- UUID v4 与 tasks 对齐 (crypto.randomUUID)
  title                  TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description            TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  repro                  TEXT CHECK(repro IS NULL OR length(repro) BETWEEN 1 AND 2000),  -- 可选重现步骤
  kind                   TEXT NOT NULL DEFAULT 'follow-up' CHECK(length(kind) BETWEEN 1 AND 32),  -- §D6 软枚举 + DDL 长度兜底
  status                 TEXT NOT NULL DEFAULT 'open',                 -- §D7 3 态: open|in-progress|resolved (zod IPC 层严格 enum)
  severity               TEXT NOT NULL DEFAULT 'medium',               -- low|medium|high (zod 严格 enum)
  source_session_id      TEXT,                                         -- 上报 session FK SET NULL §D11；agent append 校验字段 §不变量 3
  cwd                    TEXT CHECK(cwd IS NULL OR length(cwd) <= 2048),  -- 上报时 caller cwd 快照 + DDL FS path 上限兜底
  logs_ref               TEXT,                                         -- JSON: {date, tsRange?, scopes?, note?} — DB 字段 snake_case，mcp args camelCase logsRef
  resolution_session_id  TEXT,                                         -- 解决 session FK SET NULL §D11
  labels                 TEXT NOT NULL DEFAULT '[]' CHECK(length(labels) <= 8192),  -- JSON array string + DDL 防膨胀兜底
  created_at             INTEGER NOT NULL,                             -- 毫秒
  updated_at             INTEGER NOT NULL,                             -- 毫秒
  resolved_at            INTEGER,                                      -- §D15: status 进 resolved 写 now / 离开保留 / 再次进刷新
  deleted_at             INTEGER,                                      -- 软删（§D13 双轨 GC 之 UI 侧）
  FOREIGN KEY(source_session_id)     REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(resolution_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- list 默认查询（status=open + 隐藏 deleted）走 partial index 性能高
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status) WHERE deleted_at IS NULL;
-- kind 多选 filter 同款
CREATE INDEX IF NOT EXISTS idx_issues_kind ON issues(kind) WHERE deleted_at IS NULL;
-- list 默认按 created_at desc 排序
CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at DESC);
-- IssueLifecycleScheduler GC 查询 resolved + resolved_at < threshold 走 partial index
CREATE INDEX IF NOT EXISTS idx_issues_resolved_at ON issues(resolved_at) WHERE resolved_at IS NOT NULL;
-- 同款 GC 查询 deleted_at + deleted_at < threshold
CREATE INDEX IF NOT EXISTS idx_issues_deleted_at ON issues(deleted_at) WHERE deleted_at IS NOT NULL;

-- §D16 append 子表：每次 append_issue_context 调用 INSERT 一行；不动 issues.description
-- 1-2000 char 不变量；UI detail 视图 read-only 渲染 appendices 列表（按 appendedAt asc）
CREATE TABLE IF NOT EXISTS issue_appendices (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id               TEXT NOT NULL,
  body                   TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),  -- additionalContext 原文
  logs_ref               TEXT,                                         -- 可选 append 附带的新 logsRef (JSON) — handler 可选 merge 到 issues.logs_ref §D17
  appended_session_id    TEXT,                                         -- 写入时 caller sid 快照（始终 == issue.source_session_id 因 §不变量 3）；session GC 后 SET NULL
  appended_at            INTEGER NOT NULL,                             -- 毫秒
  FOREIGN KEY(issue_id)            REFERENCES issues(id)   ON DELETE CASCADE,    -- issue 硬删时 appendices 一并删 §D11
  FOREIGN KEY(appended_session_id) REFERENCES sessions(id) ON DELETE SET NULL    -- defense-in-depth 与主表对称 §D11
);

-- detail 视图 listAppendices(issueId) 查询走 (issue_id, appended_at DESC) 复合索引
CREATE INDEX IF NOT EXISTS idx_issue_appendices_issue ON issue_appendices(issue_id, appended_at DESC);
