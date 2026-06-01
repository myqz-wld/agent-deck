/**
 * session-repo cwd_release_marker 真 SQLite 单测 fixture（plan
 * codex-handoff-team-alignment-20260518 P1 Step 1.5）。
 *
 * makeMemoryDb factory + binding probe（probe 收敛到 ../../__tests__/_binding-probe SSOT，
 * plan sqlite-tests-no-skip-20260601 D3：import + re-export 让 cwd-release-marker.test 的
 * `import { bindingAvailable } from './_setup'` 0 改动可用）。
 *
 * Migration 范围 v001-v026（plan sqlite-tests-no-skip-20260601 D4）：原只载到 v020，但
 * session-repo 的 core-crud.upsert 写 cli_session_id（v021）、rename.ts 迁 tasks.owner_session_id
 * （v023）/ issues.*（v026）→ 老 fixture 缺列让 cwd-release-marker.test 4 个用例撞
 * `no such column`。补齐到 v026 与 agent-deck-repos/_setup.ts 对齐。
 * 仅 cwd-release-marker.test.ts import 本 fixture（archive.test.ts 不 import），改动 contained；
 * v021-v026 中仅 v023 含 DROP TABLE IF EXISTS tasks，fresh in-memory DB 下安全（drop 后重建）。
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
import v021 from '../../migrations/v021_sessions_cli_session_id.sql?raw';
import v022 from '../../migrations/v022_events_tool_use_dedup.sql?raw';
import v023 from '../../migrations/v023_tasks_owner_session_id_rewrite.sql?raw';
import v024 from '../../migrations/v024_tasks_add_team_id.sql?raw';
import v025 from '../../migrations/v025_events_tool_use_end_dedup.sql?raw';
import v026 from '../../migrations/v026_issues.sql?raw';

// binding probe SSOT（plan sqlite-tests-no-skip-20260601 D3）：import + re-export，
// 让 cwd-release-marker.test 的 `import { bindingAvailable } from './_setup'` 0 改动可用。
export { bindingAvailable } from '../../__tests__/_binding-probe';

/**
 * In-memory SQLite + 跑 v001-v026 全部 migration 后返回 db 实例。
 * 调用方负责 db.close()(beforeEach/afterEach pattern)。
 */
export function makeMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of [
    v001, v002, v003, v004, v005, v006, v007, v008, v009, v010,
    v011, v012, v013, v014, v015, v016, v017, v018, v019, v020,
    v021, v022, v023, v024, v025, v026,
  ]) {
    db.exec(sql);
  }
  return db;
}
