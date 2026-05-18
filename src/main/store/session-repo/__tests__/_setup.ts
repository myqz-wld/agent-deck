/**
 * session-repo cwd_release_marker 真 SQLite 单测 fixture（plan
 * codex-handoff-team-alignment-20260518 P1 Step 1.5）。
 *
 * 抽 binding probe + makeMemoryDb factory，与 store/__tests__/agent-deck-repos/_setup.ts
 * 同款 pattern。区别:本 setup 加载到 v020 (cwd_release_marker)+ v018 (model)+ v019
 * (extra_allow_write) 确保 session-repo 所有 setter / upsert / rename 测试不撞列不存在。
 *
 * 不引共享 _setup.ts: agent-deck-repos/_setup.ts 当前只载到 v017,加 v018-v020 可能影响
 * 现有 team-repo / message-repo 测试(虽然只是 ALTER ADD COLUMN 不破坏 INSERT 语义,但
 * 改共享 fixture 任何 regression 风险都比独立 fixture 高)。本 setup 独立维护,只服务
 * session-repo/__tests__/ 内的真 SQLite test。
 */

import Database from 'better-sqlite3';
import v001 from '../../migrations/v001_init.sql?raw';
import v002 from '../../migrations/v002_sessions_source.sql?raw';
import v003 from '../../migrations/v003_split_archive_from_lifecycle.sql?raw';
import v004 from '../../migrations/v004_sessions_permission_mode.sql?raw';
import v005 from '../../migrations/v005_fts.sql?raw';
import v006 from '../../migrations/v006_sessions_team_name.sql?raw';
import v007 from '../../migrations/v007_tasks.sql?raw';
import v008 from '../../migrations/v008_sessions_codex_sandbox.sql?raw';
import v009 from '../../migrations/v009_mcp_spawn_chain.sql?raw';
import v010 from '../../migrations/v010_agent_deck_teams.sql?raw';
import v011 from '../../migrations/v011_tasks_team_id.sql?raw';
import v012 from '../../migrations/v012_sessions_generic_pty_config.sql?raw';
import v013 from '../../migrations/v013_sessions_claude_code_sandbox.sql?raw';
import v014 from '../../migrations/v014_drop_sessions_team_name.sql?raw';
import v015 from '../../migrations/v015_agent_deck_messages_reply_to.sql?raw';
import v016 from '../../migrations/v016_agent_deck_teams_archive_reason.sql?raw';
import v017 from '../../migrations/v017_agent_deck_team_members_cascade.sql?raw';
import v018 from '../../migrations/v018_sessions_model.sql?raw';
import v019 from '../../migrations/v019_sessions_extra_allow_write.sql?raw';
import v020 from '../../migrations/v020_sessions_cwd_release_marker.sql?raw';

function probeBetterSqliteBinding(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch (e) {
    console.warn(
      `[session-repo.test] better-sqlite3 binding 不可用,跳过本文件全部用例。` +
        `若需本地实测:临时跑 pnpm rebuild better-sqlite3,跑完 pnpm install 还原。原因:${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

export const bindingAvailable = probeBetterSqliteBinding();

/**
 * In-memory SQLite + 跑 v001-v020 全部 migration 后返回 db 实例。
 * 调用方负责 db.close()(beforeEach/afterEach pattern)。
 */
export function makeMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of [
    v001, v002, v003, v004, v005, v006, v007, v008, v009, v010,
    v011, v012, v013, v014, v015, v016, v017, v018, v019, v020,
  ]) {
    db.exec(sql);
  }
  return db;
}
