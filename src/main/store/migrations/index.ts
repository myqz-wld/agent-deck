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
];
