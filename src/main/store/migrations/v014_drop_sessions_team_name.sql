-- plan team-cohesion-fix-20260513 Phase A Step A9 — drop sessions.team_name 列
--
-- v006 (sessions_team_name) 引入 sessions.team_name 列时，universal team backend (v010)
-- 还没有；R3 重写后 universal team backend (agent_deck_teams + agent_deck_team_members)
-- 是 team 关系唯一权威，sessions.team_name 列 deprecated 等待删除。
--
-- 本 migration 两步走：
--   Step 1: backfill — 把 sessions.team_name 非空且 universal team backend 没 active member
--           的 session 补 ensureByName + addMember(role:'teammate')。历史不知道 lead/teammate
--           角色，统一打 teammate 安全（lead 角色后续 spawn_session 重新建立时形成）。
--   Step 2: drop column。
--
-- SQLite DROP COLUMN 需 ≥ 3.35 (2021)；better-sqlite3 11.x 默认 ≥ 3.42 OK。
-- v006 同时建过 partial index `idx_sessions_team_name ON sessions(team_name) WHERE
-- team_name IS NOT NULL`；SQLite ALTER TABLE DROP COLUMN 拒绝 column 被任何 index
-- 引用（含 partial index 的 WHERE 表达式），所以 Step 2 之前必须先 drop index，
-- 否则整 migration 事务回滚 → 应用 bootstrap fatal（v014 首跑必挂）。

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1.a: 把 sessions.team_name 非空但 agent_deck_teams 没对应 active team 的 → ensureByName
-- ────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO agent_deck_teams (id, name, created_at, archived_at, metadata)
SELECT DISTINCT
  -- 12 char hex pseudo-id (与 nanoid 风格类似，碰撞概率忽略)
  lower(hex(randomblob(6))),
  s.team_name,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  NULL,
  '{"source":"v014-backfill"}'
FROM sessions s
WHERE s.team_name IS NOT NULL
  AND s.team_name NOT IN (
    SELECT name FROM agent_deck_teams WHERE archived_at IS NULL
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1.b: 把 sessions.team_name 非空但 universal team backend 没对应 active membership 的
-- → addMember(role:'teammate')。joined_at 用 sessions.started_at，保留时间近似。
-- ────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO agent_deck_team_members
  (team_id, session_id, role, display_name, joined_at, left_at)
SELECT
  t.id,
  s.id,
  'teammate',
  NULL,
  s.started_at,
  NULL
FROM sessions s
INNER JOIN agent_deck_teams t
  ON t.name = s.team_name AND t.archived_at IS NULL
WHERE s.team_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_deck_team_members m
    WHERE m.team_id = t.id AND m.session_id = s.id
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: drop column。先 drop v006 创建的 partial index（SQLite 不允许 column
-- 被 index 引用时 DROP COLUMN）。删 column 后 SQL 内任何 team_name 引用都会
-- 报 "no such column"，必须在 application code (sessionRepo.toSessionRecord /
-- INSERT / UPDATE / rename) 同步清理引用（plan team-cohesion-fix-20260513
-- Phase A 同 commit 一并处理）。
-- ────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_sessions_team_name;
ALTER TABLE sessions DROP COLUMN team_name;
