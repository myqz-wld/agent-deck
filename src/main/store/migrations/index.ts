/**
 * Ordered migration registry embedded into the main bundle with `?raw`.
 *
 * Versions must remain contiguous. Each entry declares whether normal startup
 * may execute it; offline entries also expose their stable operator command.
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
import v047 from './v047_sessions_agent_runtime_profile.sql?raw';
import v048 from './v048_codex_output_token_totals.sql?raw';
import v049 from './v049_sessions_codex_approval_policy.sql?raw';
import v050 from './v050_sessions_grok_usage_watermark.sql?raw';
import v051 from './v051_token_usage_presence.sql?raw';
import v052 from './v052_token_usage_metric_scope_repair.sql?raw';
import v053 from './v053_sessions_grok_sandbox.sql?raw';
import v054 from './v054_message_delivery_generation.sql?raw';

interface MigrationBase {
  version: number;
  name: string;
  sql: string;
}

export type Migration =
  | (MigrationBase & {
      execution: 'startup';
    })
  | (MigrationBase & {
      execution: 'offline';
      freshInstallSafe: boolean;
      command: string;
    });

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', execution: 'startup', sql: v001 },
  { version: 2, name: 'sessions_source', execution: 'startup', sql: v002 },
  { version: 3, name: 'split_archive_from_lifecycle', execution: 'startup', sql: v003 },
  { version: 4, name: 'sessions_permission_mode', execution: 'startup', sql: v004 },
  { version: 5, name: 'fts5', execution: 'startup', sql: v005 },
  { version: 6, name: 'sessions_team_name', execution: 'startup', sql: v006 },
  { version: 7, name: 'tasks', execution: 'startup', sql: v007 },
  { version: 8, name: 'sessions_codex_sandbox', execution: 'startup', sql: v008 },
  { version: 9, name: 'mcp_spawn_chain', execution: 'startup', sql: v009 },
  { version: 10, name: 'agent_deck_teams', execution: 'startup', sql: v010 },
  { version: 11, name: 'tasks_team_id', execution: 'startup', sql: v011 },
  { version: 12, name: 'sessions_generic_pty_config', execution: 'startup', sql: v012 },
  { version: 13, name: 'sessions_claude_code_sandbox', execution: 'startup', sql: v013 },
  { version: 14, name: 'drop_sessions_team_name', execution: 'startup', sql: v014 },
  { version: 15, name: 'agent_deck_messages_reply_to', execution: 'startup', sql: v015 },
  { version: 16, name: 'agent_deck_teams_archive_reason', execution: 'startup', sql: v016 },
  { version: 17, name: 'agent_deck_team_members_cascade', execution: 'startup', sql: v017 },
  { version: 18, name: 'sessions_model', execution: 'startup', sql: v018 },
  { version: 19, name: 'sessions_extra_allow_write', execution: 'startup', sql: v019 },
  { version: 20, name: 'sessions_cwd_release_marker', execution: 'startup', sql: v020 },
  { version: 21, name: 'sessions_cli_session_id', execution: 'startup', sql: v021 },
  { version: 22, name: 'events_tool_use_dedup', execution: 'startup', sql: v022 },
  { version: 23, name: 'tasks_owner_session_id_rewrite', execution: 'startup', sql: v023 },
  { version: 24, name: 'tasks_add_team_id', execution: 'startup', sql: v024 },
  { version: 25, name: 'events_tool_use_end_dedup', execution: 'startup', sql: v025 },
  { version: 26, name: 'issues', execution: 'startup', sql: v026 },
  { version: 27, name: 'agent_deck_messages_team_id_nullable', execution: 'startup', sql: v027 },
  { version: 28, name: 'token_usage', execution: 'startup', sql: v028 },
  { version: 29, name: 'sessions_network_dirs', execution: 'startup', sql: v029 },
  { version: 30, name: 'agent_deck_messages_indexes', execution: 'startup', sql: v030 },
  { version: 31, name: 'file_change_snapshots', execution: 'startup', sql: v031 },
  { version: 32, name: 'sessions_thinking', execution: 'startup', sql: v032 },
  { version: 33, name: 'issues_branch_name', execution: 'startup', sql: v033 },
  { version: 34, name: 'sessions_list_filter_indexes', execution: 'startup', sql: v034 },
  { version: 35, name: 'token_usage_reasoning', execution: 'startup', sql: v035 },
  { version: 36, name: 'token_usage_model_buckets', execution: 'startup', sql: v036 },
  { version: 37, name: 'event_revisions', execution: 'startup', sql: v037 },
  { version: 38, name: 'continuation_checkpoints', execution: 'startup', sql: v038 },
  { version: 39, name: 'sessions_pinned', execution: 'startup', sql: v039 },
  { version: 40, name: 'summary_revision_metadata', execution: 'startup', sql: v040 },
  { version: 41, name: 'storage_maintenance_staging', execution: 'startup', sql: v041 },
  { version: 42, name: 'session_handoff_aliases', execution: 'startup', sql: v042 },
  {
    version: 43,
    name: 'history_search_case_insensitive',
    execution: 'offline',
    freshInstallSafe: true,
    command: 'migrate:history-search',
    sql: v043,
  },
  { version: 44, name: 'sessions_hidden_from_history', execution: 'startup', sql: v044 },
  { version: 45, name: 'sessions_adapter_mode', execution: 'startup', sql: v045 },
  { version: 46, name: 'sessions_runtime_provider', execution: 'startup', sql: v046 },
  { version: 47, name: 'sessions_agent_runtime_profile', execution: 'startup', sql: v047 },
  { version: 48, name: 'codex_output_token_totals', execution: 'startup', sql: v048 },
  { version: 49, name: 'sessions_codex_approval_policy', execution: 'startup', sql: v049 },
  { version: 50, name: 'sessions_grok_usage_watermark', execution: 'startup', sql: v050 },
  { version: 51, name: 'token_usage_presence', execution: 'startup', sql: v051 },
  { version: 52, name: 'token_usage_metric_scope_repair', execution: 'startup', sql: v052 },
  { version: 53, name: 'sessions_grok_sandbox', execution: 'startup', sql: v053 },
  { version: 54, name: 'message_delivery_generation', execution: 'startup', sql: v054 },
];
