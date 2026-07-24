/**
 * agent-deck-repos 单测共享 fixture（CHANGELOG_105 拆分自 agent-deck-repos.test.ts）。
 *
 * 抽出 better-sqlite3 binding probe + in-memory DB factory + insertSession helper +
 * latest-schema ?raw migration imports，让 team-repo 与 message-repo 两组 test 复用。
 *
 * 与 task-repo.test.ts 同 pattern：bind probe 失败时 skip 整个 describe。
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
import v027 from '../../migrations/v027_agent_deck_messages_team_id_nullable.sql?raw';
import v028 from '../../migrations/v028_token_usage.sql?raw';
import v029 from '../../migrations/v029_sessions_network_dirs.sql?raw';
import v030 from '../../migrations/v030_agent_deck_messages_indexes.sql?raw';
import v031 from '../../migrations/v031_file_change_snapshots.sql?raw';
import v032 from '../../migrations/v032_sessions_thinking.sql?raw';
import v033 from '../../migrations/v033_issues_branch_name.sql?raw';
import v034 from '../../migrations/v034_sessions_list_filter_indexes.sql?raw';
import v035 from '../../migrations/v035_token_usage_reasoning.sql?raw';
import v036 from '../../migrations/v036_token_usage_model_buckets.sql?raw';
import v037 from '../../migrations/v037_event_revisions.sql?raw';
import v038 from '../../migrations/v038_continuation_checkpoints.sql?raw';
import v039 from '../../migrations/v039_sessions_pinned.sql?raw';
import v040 from '../../migrations/v040_summary_revision_metadata.sql?raw';
import v041 from '../../migrations/v041_storage_maintenance_staging.sql?raw';
import v042 from '../../migrations/v042_session_handoff_aliases.sql?raw';
import v043 from '../../migrations/v043_history_search_case_insensitive.sql?raw';
import v044 from '../../migrations/v044_sessions_hidden_from_history.sql?raw';
import v045 from '../../migrations/v045_sessions_adapter_mode.sql?raw';
import v046 from '../../migrations/v046_sessions_runtime_provider.sql?raw';

// binding probe SSOT（plan sqlite-tests-no-skip-20260601 D3）：import + re-export，
// 让本 _setup 的 7 个下游 consumer（team-repo / message-repo / task-repo / issue-repo /
// rejoin-after-soft-exit / swap-lead + agent-deck-mcp dormant-teammate-shutdown）的
// `import { bindingAvailable } from './...../_setup'` 继续可用，0 改动。
export { bindingAvailable } from '../_binding-probe';

export function makeMemoryDb(dbPath = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of [
    v001,
    v002,
    v003,
    v004,
    v005,
    v006,
    v007,
    v008,
    v009,
    v010,
    v011,
    v012,
    v013,
    v014,
    v015,
    v016,
    v017,
    v018,
    v019,
    v020,
    v021,
    v022,
    v023,
    v024,
    v025,
    v026,
    v027,
    v028,
    v029,
    v030,
    v031,
    v032,
    v033,
    v034,
    v035,
    v036,
    v037,
    v038,
    v039,
    v040,
    v041,
    v042,
    v043,
    v044,
    v045,
    v046,
  ]) {
    db.exec(sql);
  }
  return db;
}

export function insertSession(db: Database.Database, id: string, agentId = 'claude-code'): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, ?, ?, ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, agentId, '/tmp', `title-${id}`, 1000, 1000);
}
