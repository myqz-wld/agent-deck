-- v017 — agent_deck_team_members.session_id RESTRICT → CASCADE（plan linked-swimming-platypus）
--
-- 修正 v010 设计冲突：原 RESTRICT FK 阻塞 sessions DELETE，要求 caller 先 leaveTeam +
-- 删 row。但 leaveTeam 只 UPDATE left_at 不物理删 row → pre-check「兜底」实际失效，
-- 任何在 active team_members 的 session：
--   1. sessionRepo.rename 内 DELETE OLD 撞 FK（用户报 bug：fork rename 后 SDK 流中断
--      "FOREIGN KEY constraint failed"，详见 CHANGELOG_96 + plan）
--   2. sessionManager.delete 走 leaveTeamsAndAutoArchive(写 left_at) → sessionRepo.delete
--      → DELETE FROM sessions → 同款 FK 拦截（隐藏 bug，UI「删除」按钮永远删不掉带
--      active membership 的 session）
--
-- 改 CASCADE 后 sessions DELETE 自动级联清 team_members rows，sessionManager.delete +
-- sessionRepo.rename 路径不再撞 FK。v010 设计意图「保留 member 历史」与物理 RESTRICT
-- 拦死本就互斥；改 CASCADE 后接受 row 跟随 session 一起被清（member 历史归属感本就在
-- session 一侧，session 真删了关联失去意义）。
--
-- application 层 rename 路径仍需主动 UPDATE 迁 team_members.session_id（OLD → NEW），
-- 不能依赖 CASCADE 自动删 —— 那会让 NEW session 失去 OLD 在 team 里的 lead/teammate 角色，
-- team 自动 archive，违反 rename「OLD 整个迁到 NEW 名下」的语义意图（详 rename.ts 同 plan）。
--
-- SQLite 改 FK 必须 recreate table（12-step 流程）；DROP COLUMN 同款约束（v014 模式）。
-- _new 临时表 + INSERT FROM old + DROP old + RENAME _new → old + 重建 indexes。
-- migration 整段在 db.ts 的 db.transaction(() => for migration: db.exec) 内跑，
-- DROP TABLE / RENAME 在事务内安全（agent_deck_team_members 没被任何表 FK 反引用）。

CREATE TABLE agent_deck_team_members_new (
  team_id      TEXT NOT NULL REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('lead', 'teammate')),
  display_name TEXT,
  joined_at    INTEGER NOT NULL,
  left_at      INTEGER,
  PRIMARY KEY (team_id, session_id)
);

INSERT INTO agent_deck_team_members_new
  (team_id, session_id, role, display_name, joined_at, left_at)
SELECT team_id, session_id, role, display_name, joined_at, left_at
FROM agent_deck_team_members;

DROP TABLE agent_deck_team_members;

ALTER TABLE agent_deck_team_members_new RENAME TO agent_deck_team_members;

CREATE INDEX IF NOT EXISTS idx_team_members_session_id
  ON agent_deck_team_members(session_id);

CREATE INDEX IF NOT EXISTS idx_team_members_team_id_role
  ON agent_deck_team_members(team_id, role);

CREATE INDEX IF NOT EXISTS idx_team_members_active_session
  ON agent_deck_team_members(session_id, team_id) WHERE left_at IS NULL;
