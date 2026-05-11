-- R3.E2 / E0 ADR §2.2 — Agent Deck Universal Team Backend
--
-- 本 migration 引入 adapter-agnostic team 抽象的三表 schema：
--   1. agent_deck_teams           — team 元信息（独立 entity）
--   2. agent_deck_team_members    — team ↔ session 多对多
--   3. agent_deck_messages        — cross-session 通讯 envelope（universal-message-watcher 投递）
--
-- 与老 sessions.team_name (v006) **正交**：
--   - sessions.team_name 列保留只读历史（PR-A 阶段不删，下次大版本 v012 删）
--   - 新代码不写 sessions.team_name；spawn_session 改写 agent_deck_teams 三表
--   - 应用层 distinctTeamNames / findByTeamName / clearTeamName / setTeamName 在 PR-B (E6) 全删
--
-- 与 R2 spawn_chain (v009) **正交**：spawned_by / spawn_depth 是 MCP spawn-time 防递归，
-- 与 team membership 无关。watcher 不用 spawn_chain 字段做 team 路由。

-- ────────────────────────────────────────────────────────────────────────────
-- 1) team 元信息
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_deck_teams (
  id          TEXT PRIMARY KEY NOT NULL,           -- nanoid 12 字符（与 task-repo 同款）
  name        TEXT NOT NULL,                       -- 用户可见名（active 内 unique，见下方部分索引）
  created_at  INTEGER NOT NULL,                    -- 毫秒
  archived_at INTEGER,                             -- NULL = active；非 NULL = 用户归档（UI 默认隐藏）
  metadata    TEXT NOT NULL DEFAULT '{}'           -- JSON（自由扩展位）
              CHECK (json_valid(metadata))         -- SQLite 兜底；防误塞非 JSON
);

-- active team name 唯一（archived 不限）—— 落地了 §2.1 invariant + §5.1 spawn_session
-- ensure-team-by-name 并发安全（reviewer 反驳轮 finding #4）。
-- repo 层用 INSERT ... ON CONFLICT DO NOTHING + 同步 SELECT 序列化，不走 BEGIN IMMEDIATE
-- 长事务避免与 universal-message-watcher poll 竞争 WAL 写锁。
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_deck_teams_active_name
  ON agent_deck_teams(name) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_deck_teams_archived_at
  ON agent_deck_teams(archived_at);

CREATE INDEX IF NOT EXISTS idx_agent_deck_teams_created_at
  ON agent_deck_teams(created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) team ↔ session 多对多
-- ────────────────────────────────────────────────────────────────────────────
--
-- session_id FK 用 RESTRICT（非 CASCADE）—— reviewer HIGH-2 修法：
-- sessions 行被 hard-delete（用户 UI 删 / lifecycle-scheduler 30 天清理）时不会级联
-- 干掉 member 历史。session 删除前必须先调 agent-deck-team-repo.leaveTeam(sid)
-- 或 archiveTeam，否则 sessionRepo.delete throw FK 错。
-- sessionManager.delete 入口加 pre-check 兜底（详 ADR §2.5），UI 入口同步显式 confirm。
--
-- team_id FK 仍 CASCADE：用户显式 hardDeleteTeam（管理员行为）才走，正常归档不删行。
CREATE TABLE IF NOT EXISTS agent_deck_team_members (
  team_id      TEXT NOT NULL REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  role         TEXT NOT NULL CHECK (role IN ('lead', 'teammate')),
  display_name TEXT,                                -- 可选别名（如 "reviewer-claude"）
  joined_at    INTEGER NOT NULL,                    -- 毫秒
  left_at      INTEGER,                             -- NULL = active；非 NULL = 退出（仍可 read，watcher 不再投递）
  PRIMARY KEY (team_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_session_id
  ON agent_deck_team_members(session_id);

CREATE INDEX IF NOT EXISTS idx_team_members_team_id_role
  ON agent_deck_team_members(team_id, role);

-- 反查「同 caller 与 target 共享哪些 active team」用（§5.2 send_message handler）：
--   SELECT a.team_id FROM agent_deck_team_members a
--   INNER JOIN agent_deck_team_members b ON a.team_id=b.team_id
--   WHERE a.session_id=? AND b.session_id=? AND a.left_at IS NULL AND b.left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_members_active_session
  ON agent_deck_team_members(session_id, team_id) WHERE left_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) message envelope（cross-session 通讯日志 + 投递状态机）
-- ────────────────────────────────────────────────────────────────────────────
--
-- 状态机（详 ADR §4.3）：
--   pending → claim(原子化 UPDATE ... RETURNING) → delivering →
--     ↓ success: delivered (terminal)
--     ↓ throw:   pending (attempt_count++, last_attempt_at=now) | failed (attempt_count >= 3)
--   或 cancelled (terminal, 来自显式 cancelMessage IPC)
--
-- 关键字段：
-- - last_attempt_at  reviewer HIGH-1 修法：替代 sent_at 做退避基准（避免 sent_at 不退避 bug）
-- - delivering_since 进入 delivering 时间；crash recovery 用 (§4.6 不再无条件 ++ attempt_count)
CREATE TABLE IF NOT EXISTS agent_deck_messages (
  id              TEXT PRIMARY KEY NOT NULL,        -- nanoid 16 字符
  team_id         TEXT NOT NULL REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL,                    -- 不强制 FK（允许已 closed / 已删的 sender 留痕）
  to_session_id   TEXT NOT NULL,                    -- 同上
  body            TEXT NOT NULL CHECK (length(body) <= 102400),  -- 100KB hard cap（caller-side 也校验）
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
  status_reason   TEXT,                             -- failed / cancelled 时的原因（可读，UI 显示）
  sent_at         INTEGER NOT NULL,                 -- 毫秒（caller 入队时间，不可变）
  delivered_at    INTEGER,                          -- watcher 成功调 receiveTeammateMessage 后填
  attempt_count   INTEGER NOT NULL DEFAULT 0,       -- 已用 attempt 次数（0 → 3 → failed）
  last_attempt_at INTEGER,                          -- 最近一次 attempt 触发时间；attempt_count++ 同步更新
  delivering_since INTEGER                          -- 进入 delivering 时间；crash recovery 用 (§4.6)
);

-- watcher 主查询：WHERE status='pending' AND (last_attempt_at IS NULL OR last_attempt_at < now - backoff)
CREATE INDEX IF NOT EXISTS idx_messages_status_last_attempt
  ON agent_deck_messages(status, last_attempt_at);

-- TeamDetail UI 拉一个 team 的近期消息流：ORDER BY sent_at DESC
CREATE INDEX IF NOT EXISTS idx_messages_team_id_sent_at
  ON agent_deck_messages(team_id, sent_at DESC);

-- 反查某 receiver session 收到了哪些 message
CREATE INDEX IF NOT EXISTS idx_messages_to_session_id
  ON agent_deck_messages(to_session_id);

-- per-target backpressure 反查「to_session_id 当前 in-flight count」(§7.5)：
--   SELECT count(*) FROM agent_deck_messages
--   WHERE to_session_id=? AND status IN ('pending','delivering')
CREATE INDEX IF NOT EXISTS idx_messages_to_session_pending
  ON agent_deck_messages(to_session_id, status) WHERE status IN ('pending','delivering');
