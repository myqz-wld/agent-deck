/**
 * Migration 注册表（CHANGELOG_22 / Phase 4 N4 单轨化）
 *
 * 历史：之前 db.ts 内联 V1-V4 SQL 字符串 + migrations/v001_init.sql 同时存在但只有
 * v001 被同步、v002-v004 完全没有文件，外人维护极易写错（以为改 sql 文件生效）。
 * 现在唯一来源是 migrations/v00x_*.sql，db.ts 通过本文件 import。
 *
 * 用 Vite 的 `?raw` import：build 时把 sql 文件作为字符串内联到 main bundle，运行时
 * 不需要 fs.readFileSync，避免 dev/asar 路径分歧（CHANGELOG_15 ENOTDIR 教训）。
 *
 * 加新 migration（V5+）：写 v00X_xxx.sql + 在数组里加一行 import + push 进 MIGRATIONS。
 * version 字段必须严格递增、连续；name 用于日志与排错。
 */
import v001 from './v001_init.sql?raw';
import v002 from './v002_sessions_source.sql?raw';
import v003 from './v003_split_archive_from_lifecycle.sql?raw';
import v004 from './v004_sessions_permission_mode.sql?raw';
import v005 from './v005_fts.sql?raw';
import v006 from './v006_sessions_team_name.sql?raw';
import v007 from './v007_tasks.sql?raw';
import v008 from './v008_sessions_codex_sandbox.sql?raw';
import v009 from './v009_mcp_spawn_chain.sql?raw';
import v010 from './v010_agent_deck_teams.sql?raw';
import v011 from './v011_tasks_team_id.sql?raw';
import v012 from './v012_sessions_generic_pty_config.sql?raw';
import v013 from './v013_sessions_claude_code_sandbox.sql?raw';
import v014 from './v014_drop_sessions_team_name.sql?raw';
import v015 from './v015_agent_deck_messages_reply_to.sql?raw';
import v016 from './v016_agent_deck_teams_archive_reason.sql?raw';
import v017 from './v017_agent_deck_team_members_cascade.sql?raw';
import v018 from './v018_sessions_model.sql?raw';
import v019 from './v019_sessions_extra_allow_write.sql?raw';
import v020 from './v020_sessions_cwd_release_marker.sql?raw';
import v021 from './v021_sessions_cli_session_id.sql?raw';
import v022 from './v022_events_tool_use_dedup.sql?raw';
import v023 from './v023_tasks_owner_session_id_rewrite.sql?raw';
import v024 from './v024_tasks_add_team_id.sql?raw';
import v025 from './v025_events_tool_use_end_dedup.sql?raw';
import v026 from './v026_issues.sql?raw';
import v027 from './v027_agent_deck_messages_team_id_nullable.sql?raw';
import v028 from './v028_token_usage.sql?raw';
import v029 from './v029_sessions_network_dirs.sql?raw';
import v030 from './v030_agent_deck_messages_indexes.sql?raw';
import v031 from './v031_file_change_snapshots.sql?raw';
import v032 from './v032_sessions_thinking.sql?raw';
import v033 from './v033_issues_branch_name.sql?raw';
import v034 from './v034_sessions_list_filter_indexes.sql?raw';
import v035 from './v035_token_usage_reasoning.sql?raw';
import v036 from './v036_token_usage_model_buckets.sql?raw';
import v037 from './v037_event_revisions.sql?raw';
import v038 from './v038_continuation_checkpoints.sql?raw';
import v039 from './v039_sessions_pinned.sql?raw';
import v040 from './v040_summary_revision_metadata.sql?raw';
import v041 from './v041_storage_maintenance_staging.sql?raw';
import v042 from './v042_session_handoff_aliases.sql?raw';
import v043 from './v043_history_search_case_insensitive.sql?raw';
import v044 from './v044_sessions_hidden_from_history.sql?raw';
import v045 from './v045_sessions_adapter_mode.sql?raw';
import v046 from './v046_sessions_runtime_provider.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: v001 },
  { version: 2, name: 'sessions_source', sql: v002 },
  { version: 3, name: 'split_archive_from_lifecycle', sql: v003 },
  { version: 4, name: 'sessions_permission_mode', sql: v004 },
  { version: 5, name: 'fts5', sql: v005 },
  { version: 6, name: 'sessions_team_name', sql: v006 },
  { version: 7, name: 'tasks', sql: v007 },
  { version: 8, name: 'sessions_codex_sandbox', sql: v008 },
  { version: 9, name: 'mcp_spawn_chain', sql: v009 },
  { version: 10, name: 'agent_deck_teams', sql: v010 },
  { version: 11, name: 'tasks_team_id', sql: v011 },
  { version: 12, name: 'sessions_generic_pty_config', sql: v012 },
  { version: 13, name: 'sessions_claude_code_sandbox', sql: v013 },
  { version: 14, name: 'drop_sessions_team_name', sql: v014 },
  { version: 15, name: 'agent_deck_messages_reply_to', sql: v015 },
  { version: 16, name: 'agent_deck_teams_archive_reason', sql: v016 },
  { version: 17, name: 'agent_deck_team_members_cascade', sql: v017 },
  { version: 18, name: 'sessions_model', sql: v018 },
  { version: 19, name: 'sessions_extra_allow_write', sql: v019 },
  { version: 20, name: 'sessions_cwd_release_marker', sql: v020 },
  { version: 21, name: 'sessions_cli_session_id', sql: v021 },
  { version: 22, name: 'events_tool_use_dedup', sql: v022 },
  { version: 23, name: 'tasks_owner_session_id_rewrite', sql: v023 },
  { version: 24, name: 'tasks_add_team_id', sql: v024 },
  { version: 25, name: 'events_tool_use_end_dedup', sql: v025 },
  { version: 26, name: 'issues', sql: v026 },
  { version: 27, name: 'agent_deck_messages_team_id_nullable', sql: v027 },
  { version: 28, name: 'token_usage', sql: v028 },
  { version: 29, name: 'sessions_network_dirs', sql: v029 },
  { version: 30, name: 'agent_deck_messages_indexes', sql: v030 },
  { version: 31, name: 'file_change_snapshots', sql: v031 },
  { version: 32, name: 'sessions_thinking', sql: v032 },
  { version: 33, name: 'issues_branch_name', sql: v033 },
  { version: 34, name: 'sessions_list_filter_indexes', sql: v034 },
  { version: 35, name: 'token_usage_reasoning', sql: v035 },
  { version: 36, name: 'token_usage_model_buckets', sql: v036 },
  { version: 37, name: 'event_revisions', sql: v037 },
  { version: 38, name: 'continuation_checkpoints', sql: v038 },
  { version: 39, name: 'sessions_pinned', sql: v039 },
  { version: 40, name: 'summary_revision_metadata', sql: v040 },
  { version: 41, name: 'storage_maintenance_staging', sql: v041 },
  { version: 42, name: 'session_handoff_aliases', sql: v042 },
  { version: 43, name: 'history_search_case_insensitive', sql: v043 },
  { version: 44, name: 'sessions_hidden_from_history', sql: v044 },
  { version: 45, name: 'sessions_adapter_mode', sql: v045 },
  { version: 46, name: 'sessions_runtime_provider', sql: v046 },
];
