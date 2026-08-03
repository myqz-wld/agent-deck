-- Current-schema baseline. Existing databases with another user_version are intentionally unsupported.

CREATE TABLE agent_deck_messages (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL,
  to_session_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 102400),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
  status_reason TEXT,
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  delivering_since INTEGER,
  reply_to_message_id TEXT REFERENCES agent_deck_messages(id) ON DELETE SET NULL,
  delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
  delivery_lease_to_session_id TEXT
);

CREATE TABLE agent_deck_team_members (
  team_id TEXT NOT NULL REFERENCES agent_deck_teams(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('lead', 'teammate')),
  display_name TEXT,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (team_id, session_id)
);

CREATE TABLE agent_deck_teams (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  archive_reason TEXT
);

CREATE TABLE continuation_checkpoints (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation                    INTEGER NOT NULL CHECK(generation >= 1),
  parent_checkpoint_id          INTEGER REFERENCES continuation_checkpoints(id) ON DELETE SET NULL,
  format_version                INTEGER NOT NULL CHECK(format_version >= 1),
  source_event_revision         INTEGER NOT NULL CHECK(source_event_revision >= 0),
  source_rebuild_after_revision INTEGER NOT NULL CHECK(source_rebuild_after_revision >= 0),
  source_max_event_id           INTEGER,
  payload_json                  TEXT NOT NULL CHECK(json_valid(payload_json)),
  content_hash                  TEXT NOT NULL CHECK(length(content_hash) = 64),
  generator_adapter             TEXT NOT NULL,
  generator_model               TEXT,
  generator_thinking            TEXT,
  trigger                       TEXT NOT NULL,
  input_tokens                  INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens                 INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  checkpoint_tokens             INTEGER CHECK(checkpoint_tokens IS NULL OR checkpoint_tokens >= 0),
  created_at                    INTEGER NOT NULL,
  UNIQUE(session_id, generation)
);

CREATE VIRTUAL TABLE event_search_fts_v1 USING fts5(
  search_text,
  content='',
  contentless_delete=1,
  tokenize='trigram case_sensitive 0'
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  tool_use_id TEXT,
  change_revision INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_blob TEXT,
  after_blob TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tool_call_id TEXT,
  ts INTEGER NOT NULL,
  before_snapshot_hash BLOB REFERENCES file_snapshot_blobs(digest) ON DELETE RESTRICT,
  after_snapshot_hash BLOB REFERENCES file_snapshot_blobs(digest) ON DELETE RESTRICT,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE file_snapshot_blobs (
  digest BLOB PRIMARY KEY CHECK(length(digest) = 32),
  codec TEXT NOT NULL CHECK(codec = 'deflate-raw-1'),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0),
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes >= 0),
  data BLOB NOT NULL
) WITHOUT ROWID;

CREATE TABLE file_snapshot_gc_queue (
  digest BLOB PRIMARY KEY CHECK(length(digest) = 32),
  queued_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE issue_appendices (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id               TEXT NOT NULL,
  body                   TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  logs_ref               TEXT,
  appended_session_id    TEXT,
  appended_at            INTEGER NOT NULL,
  FOREIGN KEY(issue_id)            REFERENCES issues(id)   ON DELETE CASCADE,
  FOREIGN KEY(appended_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE issues (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description            TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  repro                  TEXT CHECK(repro IS NULL OR length(repro) BETWEEN 1 AND 2000),
  kind                   TEXT NOT NULL DEFAULT 'follow-up' CHECK(length(kind) BETWEEN 1 AND 32),
  status                 TEXT NOT NULL DEFAULT 'open',
  severity               TEXT NOT NULL DEFAULT 'medium',
  source_session_id      TEXT,
  cwd                    TEXT CHECK(cwd IS NULL OR length(cwd) <= 2048),
  logs_ref               TEXT,
  resolution_session_id  TEXT,
  labels                 TEXT NOT NULL DEFAULT '[]' CHECK(length(labels) <= 8192),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  resolved_at            INTEGER,
  deleted_at             INTEGER, branch_name TEXT CHECK(branch_name IS NULL OR length(branch_name) <= 255),
  FOREIGN KEY(source_session_id)     REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(resolution_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE session_event_revisions (
  session_id             TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision               INTEGER NOT NULL,
  rebuild_after_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session_handoff_aliases (
  source_session_id    TEXT PRIMARY KEY,
  successor_session_id TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  CHECK (source_session_id <> successor_session_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  runtime_provider TEXT,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cli',
  lifecycle TEXT NOT NULL,
  activity TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  ended_at INTEGER,
  archived_at INTEGER,
  pinned_at INTEGER CHECK (pinned_at IS NULL OR pinned_at >= 0),
  hidden_from_history INTEGER NOT NULL DEFAULT 0 CHECK (hidden_from_history IN (0, 1)),
  permission_mode TEXT,
  session_mode TEXT CHECK (session_mode IS NULL OR session_mode IN ('default', 'plan', 'ask')),
  agent_profile_name TEXT,
  agent_profile_source TEXT
    CHECK (agent_profile_source IS NULL OR agent_profile_source IN ('bundled', 'project', 'user', 'plugin')),
  agent_plugin_dir TEXT,
  codex_sandbox TEXT,
  codex_approval_policy TEXT
    CHECK (codex_approval_policy IS NULL OR codex_approval_policy IN ('untrusted', 'on-request', 'never')),
  claude_code_sandbox TEXT,
  grok_sandbox TEXT,
  model TEXT,
  thinking TEXT,
  extra_allow_write TEXT,
  network_access_enabled INTEGER,
  additional_directories TEXT,
  grok_usage_watermark TEXT,
  context_usage TEXT,
  spawned_by TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  spawn_depth INTEGER NOT NULL DEFAULT 0,
  cli_session_id TEXT
);

CREATE TABLE context_window_observations (
  runtime_key                    TEXT PRIMARY KEY NOT NULL CHECK(length(runtime_key) <= 4096),
  identity_version               INTEGER NOT NULL CHECK(identity_version = 1),
  adapter                        TEXT NOT NULL
    CHECK(adapter IN ('claude-code', 'codex-cli', 'grok-build')),
  runtime_provider               TEXT NOT NULL
    CHECK(length(trim(runtime_provider)) BETWEEN 1 AND 1024),
  model                          TEXT NOT NULL
    CHECK(length(trim(model)) BETWEEN 1 AND 1024),
  capacity_config_fingerprint    TEXT NOT NULL
    CHECK(length(trim(capacity_config_fingerprint)) BETWEEN 1 AND 1024),
  window_tokens                  INTEGER NOT NULL CHECK(window_tokens > 0),
  source                         TEXT NOT NULL
    CHECK(source IN ('effective-config', 'runtime-metadata', 'runtime-usage')),
  observed_at                    INTEGER NOT NULL CHECK(observed_at >= 0),
  origin_session_id              TEXT REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  trigger TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source_event_revision INTEGER NOT NULL CHECK (source_event_revision >= 0),
  source_rebuild_after_revision INTEGER NOT NULL
    CHECK (
      source_rebuild_after_revision >= 0
      AND source_rebuild_after_revision <= source_event_revision
    ),
  generation_source TEXT NOT NULL
    CHECK (generation_source IN ('llm', 'assistant-fallback', 'stats-fallback')),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE summaries_fts USING fts5(
  content,
  content='summaries',
  content_rowid='id',
  tokenize='trigram case_sensitive 0'
);

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  owner_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  active_form       TEXT,
  priority          INTEGER NOT NULL DEFAULT 5,
  blocks            TEXT NOT NULL DEFAULT '[]',
  blocked_by        TEXT NOT NULL DEFAULT '[]',
  labels            TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
, team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE SET NULL);

CREATE TABLE "token_usage" (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT,
  agent_id               TEXT NOT NULL,
  message_id             TEXT,
  model_raw              TEXT NOT NULL,
  model_bucket           TEXT NOT NULL,
  total_tokens           INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  input_tokens           INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens          INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens       INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cache_read_tokens      INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens  INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  metric_scope           INTEGER NOT NULL DEFAULT 63
                         CHECK (metric_scope >= 1 AND metric_scope <= 63),
  ts                     INTEGER NOT NULL
);

CREATE TABLE token_usage_daily_dirty_days (
  day TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE token_usage_daily_rollup (
  day                         TEXT NOT NULL,
  model_bucket                TEXT NOT NULL,
  sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
  provider_total_tokens       INTEGER,
  provider_total_applicable   INTEGER NOT NULL CHECK (provider_total_applicable IN (0, 1)),
  input_total_tokens          INTEGER,
  input_total_applicable      INTEGER NOT NULL CHECK (input_total_applicable IN (0, 1)),
  output_tokens               INTEGER,
  output_applicable           INTEGER NOT NULL CHECK (output_applicable IN (0, 1)),
  reasoning_tokens            INTEGER,
  reasoning_applicable        INTEGER NOT NULL CHECK (reasoning_applicable IN (0, 1)),
  cache_read_tokens           INTEGER,
  cache_read_applicable       INTEGER NOT NULL CHECK (cache_read_applicable IN (0, 1)),
  cache_creation_tokens       INTEGER,
  cache_creation_applicable   INTEGER NOT NULL CHECK (cache_creation_applicable IN (0, 1)),
  PRIMARY KEY (day, model_bucket)
) WITHOUT ROWID;

CREATE TABLE token_usage_daily_state (
  singleton                 INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_revision           INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  projection_revision       INTEGER NOT NULL DEFAULT -1 CHECK (projection_revision >= -1),
  timezone_fingerprint      TEXT,
  full_rebuild_required     INTEGER NOT NULL DEFAULT 1
                            CHECK (full_rebuild_required IN (0, 1))
);

CREATE TABLE worktree_cwd_transition_inputs (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (session_id, generation, sequence)
);

CREATE TABLE worktree_cwd_transitions (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation > 0),
  direction TEXT NOT NULL CHECK (direction IN ('enter', 'exit')),
  phase TEXT NOT NULL CHECK (
    phase IN (
      'creating',
      'enter_waiting_tool_result',
      'interrupting_enter_turn',
      'switching_to_worktree',
      'active',
      'exit_preflight',
      'exit_waiting_tool_result',
      'interrupting_exit_turn',
      'restoring_original_cwd',
      'cleanup_pending',
      'cleared'
    )
  ),
  original_cwd TEXT NOT NULL,
  target_cwd TEXT NOT NULL,
  main_repo TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  tool_use_id TEXT,
  continuation_key TEXT NOT NULL,
  continuation_delivered INTEGER NOT NULL DEFAULT 0
    CHECK (continuation_delivered IN (0, 1)),
  discard_changes INTEGER NOT NULL DEFAULT 0 CHECK (discard_changes IN (0, 1)),
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);

CREATE VIEW event_search_source_v1(event_id, search_text) AS
SELECT id,
  CASE
    WHEN NOT json_valid(payload_json) THEN
      CASE WHEN length(payload_json) <= 4096 THEN payload_json
           ELSE substr(payload_json, 1, 2048) || ' ' || substr(payload_json, -2048)
      END
    WHEN kind IN ('message', 'thinking') THEN
      COALESCE(json_extract(payload_json, '$.text'), '')
    WHEN kind IN ('tool-use-start', 'tool-use-end') THEN
      COALESCE(json_extract(payload_json, '$.toolName'), '') || ' ' ||
      COALESCE(CAST(json_extract(payload_json, '$.toolInput') AS TEXT), '') || ' ' ||
      COALESCE(CAST(json_extract(payload_json, '$.status') AS TEXT), '') || ' ' ||
      COALESCE(CAST(json_extract(payload_json, '$.error') AS TEXT), '') || ' ' ||
      CASE WHEN kind = 'tool-use-end' THEN
        CASE
          WHEN length(COALESCE(
            CAST(json_extract(payload_json, '$.toolResult') AS TEXT),
            CAST(json_extract(payload_json, '$.toolResponse') AS TEXT),
            ''
          )) <= 4096 THEN COALESCE(
            CAST(json_extract(payload_json, '$.toolResult') AS TEXT),
            CAST(json_extract(payload_json, '$.toolResponse') AS TEXT),
            ''
          )
          ELSE substr(COALESCE(
            CAST(json_extract(payload_json, '$.toolResult') AS TEXT),
            CAST(json_extract(payload_json, '$.toolResponse') AS TEXT),
            ''
          ), 1, 2048) || ' ' || substr(COALESCE(
            CAST(json_extract(payload_json, '$.toolResult') AS TEXT),
            CAST(json_extract(payload_json, '$.toolResponse') AS TEXT),
            ''
          ), -2048)
        END
      ELSE '' END
    WHEN kind = 'file-changed' THEN
      COALESCE(CAST(json_extract(payload_json, '$.filePath') AS TEXT), '') || ' ' ||
      COALESCE(CAST(json_extract(payload_json, '$.kind') AS TEXT), '') || ' ' ||
      COALESCE(CAST(json_extract(payload_json, '$.metadata.source') AS TEXT), '') || ' ' ||
      COALESCE(CAST(json_extract(payload_json, '$.metadata.changeKind') AS TEXT), '') || ' ' ||
      COALESCE(CAST(json_extract(payload_json, '$.metadata.patchStatus') AS TEXT), '')
    ELSE CASE WHEN length(payload_json) <= 4096 THEN payload_json
              ELSE substr(payload_json, 1, 2048) || ' ' || substr(payload_json, -2048)
         END
  END
FROM events;

CREATE UNIQUE INDEX events_tool_use_end_dedup
  ON events (session_id, kind, tool_use_id)
  WHERE kind = 'tool-use-end' AND tool_use_id IS NOT NULL;

CREATE UNIQUE INDEX events_tool_use_start_dedup
  ON events (session_id, kind, tool_use_id)
  WHERE kind = 'tool-use-start' AND tool_use_id IS NOT NULL;

CREATE UNIQUE INDEX idx_agent_deck_teams_active_name
  ON agent_deck_teams(name) WHERE archived_at IS NULL;

CREATE INDEX idx_agent_deck_teams_archived_at
  ON agent_deck_teams(archived_at);

CREATE INDEX idx_agent_deck_teams_created_at
  ON agent_deck_teams(created_at DESC);

CREATE INDEX idx_continuation_checkpoints_session_revision
  ON continuation_checkpoints(session_id, source_event_revision DESC, generation DESC);

CREATE INDEX idx_events_kind ON events(kind);

CREATE INDEX idx_events_session ON events(session_id, ts DESC);

CREATE INDEX idx_events_session_effective_revision
ON events (session_id, change_revision, id);

CREATE INDEX idx_file_changes_path ON file_changes(file_path);

CREATE INDEX idx_file_changes_session ON file_changes(session_id, ts DESC);

CREATE INDEX idx_file_changes_before_snapshot_hash
ON file_changes(before_snapshot_hash)
WHERE before_snapshot_hash IS NOT NULL;

CREATE INDEX idx_file_changes_after_snapshot_hash
ON file_changes(after_snapshot_hash)
WHERE after_snapshot_hash IS NOT NULL;

CREATE INDEX idx_issue_appendices_issue ON issue_appendices(issue_id, appended_at DESC);

CREATE INDEX idx_issues_created ON issues(created_at DESC);

CREATE INDEX idx_issues_deleted_at ON issues(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_issues_kind ON issues(kind) WHERE deleted_at IS NULL;

CREATE INDEX idx_issues_resolved_at ON issues(resolved_at) WHERE resolved_at IS NOT NULL;

CREATE INDEX idx_issues_status ON issues(status) WHERE deleted_at IS NULL;

CREATE INDEX idx_messages_from_session_sent_at
  ON agent_deck_messages(from_session_id, sent_at DESC);

CREATE INDEX idx_messages_pending_sent_at
  ON agent_deck_messages(status, sent_at)
  WHERE status = 'pending';

CREATE INDEX idx_messages_reply_to
  ON agent_deck_messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE INDEX idx_messages_status_last_attempt
  ON agent_deck_messages(status, last_attempt_at);

CREATE INDEX idx_messages_team_id_sent_at
  ON agent_deck_messages(team_id, sent_at DESC);

CREATE INDEX idx_messages_terminal_sent_at
  ON agent_deck_messages(sent_at)
  WHERE status IN ('delivered', 'failed', 'cancelled');

CREATE INDEX idx_messages_to_session_id
  ON agent_deck_messages(to_session_id);

CREATE INDEX idx_messages_to_session_pending
  ON agent_deck_messages(to_session_id, status) WHERE status IN ('pending','delivering');

CREATE INDEX idx_messages_to_session_sent_at
  ON agent_deck_messages(to_session_id, sent_at DESC);

CREATE INDEX idx_session_handoff_aliases_successor
  ON session_handoff_aliases(successor_session_id);

CREATE INDEX idx_sessions_agent ON sessions(agent_id);

CREATE UNIQUE INDEX idx_sessions_cli_session_id ON sessions(cli_session_id);

CREATE INDEX idx_sessions_history_agent_last_event
ON sessions(agent_id, last_event_at DESC)
WHERE lifecycle = 'closed' OR archived_at IS NOT NULL;

CREATE INDEX idx_sessions_history_spawned_agent_last_event
ON sessions(spawned_by, agent_id, last_event_at DESC)
WHERE lifecycle = 'closed' OR archived_at IS NOT NULL;

CREATE INDEX idx_sessions_history_spawned_last_event
ON sessions(spawned_by, last_event_at DESC)
WHERE lifecycle = 'closed' OR archived_at IS NOT NULL;

CREATE INDEX idx_sessions_last_event ON sessions(last_event_at DESC);

CREATE INDEX idx_sessions_lifecycle ON sessions(lifecycle);

CREATE INDEX idx_sessions_live_lifecycle_agent_last_event
ON sessions(lifecycle, agent_id, last_event_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX idx_sessions_live_lifecycle_spawned_agent_last_event
ON sessions(lifecycle, spawned_by, agent_id, last_event_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX idx_sessions_live_lifecycle_spawned_last_event
ON sessions(lifecycle, spawned_by, last_event_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX idx_sessions_live_pinned_last_event
ON sessions(pinned_at DESC, last_event_at DESC, id ASC)
WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant');

CREATE INDEX idx_sessions_spawned_by ON sessions(spawned_by);

CREATE INDEX idx_sessions_unpinned_history_last_event
ON sessions(last_event_at ASC, id ASC)
WHERE pinned_at IS NULL AND (lifecycle = 'closed' OR archived_at IS NOT NULL);

CREATE INDEX idx_sessions_unpinned_live_lifecycle_last_event
ON sessions(lifecycle, last_event_at)
WHERE archived_at IS NULL AND pinned_at IS NULL;

CREATE INDEX idx_summaries_session ON summaries(session_id, ts DESC);

CREATE INDEX idx_summaries_session_source_revision
ON summaries(session_id, source_event_revision DESC);

CREATE INDEX idx_tasks_owner_session_id
  ON tasks(owner_session_id);

CREATE INDEX idx_tasks_status
  ON tasks(status);

CREATE INDEX idx_tasks_team_id
  ON tasks(team_id) WHERE team_id IS NOT NULL;

CREATE INDEX idx_tasks_updated_at
  ON tasks(updated_at DESC);

CREATE INDEX idx_context_window_observations_observed_at
  ON context_window_observations(observed_at DESC);

CREATE INDEX idx_team_members_active_session
  ON agent_deck_team_members(session_id, team_id) WHERE left_at IS NULL;

CREATE INDEX idx_team_members_session_id
  ON agent_deck_team_members(session_id);

CREATE INDEX idx_team_members_team_id_role
  ON agent_deck_team_members(team_id, role);

CREATE INDEX idx_token_usage_bucket_ts ON token_usage(model_bucket, ts);

CREATE INDEX idx_token_usage_ts ON token_usage(ts);

CREATE INDEX idx_worktree_cwd_transition_inputs_pending
  ON worktree_cwd_transition_inputs(session_id, generation, delivered_at, sequence);

CREATE INDEX idx_worktree_cwd_transitions_path
  ON worktree_cwd_transitions(worktree_path, phase);

CREATE INDEX idx_worktree_cwd_transitions_phase
  ON worktree_cwd_transitions(phase, updated_at);

CREATE UNIQUE INDEX idx_worktree_cwd_transitions_tool_use
  ON worktree_cwd_transitions(session_id, generation, tool_use_id)
  WHERE tool_use_id IS NOT NULL;

CREATE UNIQUE INDEX uq_token_usage_message_id
  ON token_usage(message_id) WHERE message_id IS NOT NULL;

CREATE TRIGGER event_search_v1_ad AFTER DELETE ON events BEGIN
  DELETE FROM event_search_fts_v1 WHERE rowid = old.id;
END;

CREATE TRIGGER event_search_v1_ai AFTER INSERT ON events BEGIN
  INSERT INTO event_search_fts_v1(rowid, search_text)
    SELECT event_id, search_text FROM event_search_source_v1 WHERE event_id = new.id;
END;

CREATE TRIGGER event_search_v1_au AFTER UPDATE OF payload_json ON events
WHEN old.payload_json IS NOT new.payload_json
BEGIN
  DELETE FROM event_search_fts_v1 WHERE rowid = old.id;
  INSERT INTO event_search_fts_v1(rowid, search_text)
    SELECT event_id, search_text FROM event_search_source_v1 WHERE event_id = new.id;
END;

CREATE TRIGGER file_changes_snapshot_gc_ad AFTER DELETE ON file_changes
WHEN old.before_snapshot_hash IS NOT NULL OR old.after_snapshot_hash IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO file_snapshot_gc_queue(digest, queued_at)
    SELECT old.before_snapshot_hash, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE old.before_snapshot_hash IS NOT NULL;
  INSERT OR IGNORE INTO file_snapshot_gc_queue(digest, queued_at)
    SELECT old.after_snapshot_hash, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE old.after_snapshot_hash IS NOT NULL;
END;

CREATE TRIGGER file_changes_snapshot_gc_au
AFTER UPDATE OF before_snapshot_hash, after_snapshot_hash ON file_changes
WHEN old.before_snapshot_hash IS NOT new.before_snapshot_hash
  OR old.after_snapshot_hash IS NOT new.after_snapshot_hash
BEGIN
  INSERT OR IGNORE INTO file_snapshot_gc_queue(digest, queued_at)
    SELECT old.before_snapshot_hash, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE old.before_snapshot_hash IS NOT NULL
       AND old.before_snapshot_hash IS NOT new.before_snapshot_hash;
  INSERT OR IGNORE INTO file_snapshot_gc_queue(digest, queued_at)
    SELECT old.after_snapshot_hash, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE old.after_snapshot_hash IS NOT NULL
       AND old.after_snapshot_hash IS NOT new.after_snapshot_hash;
END;

CREATE TRIGGER session_event_revisions_event_ad
AFTER DELETE ON events
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
BEGIN
  UPDATE session_event_revisions
  SET revision = revision + 1,
      rebuild_after_revision = revision + 1
  WHERE session_id = OLD.session_id;
END;

CREATE TRIGGER session_event_revisions_event_ai
AFTER INSERT ON events
BEGIN
  UPDATE session_event_revisions
  SET revision = revision + 1
  WHERE session_id = NEW.session_id;

  UPDATE events
  SET change_revision = (
    SELECT revision
    FROM session_event_revisions
    WHERE session_id = NEW.session_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER session_event_revisions_event_au_business
AFTER UPDATE OF kind, payload_json, ts, tool_use_id ON events
WHEN OLD.kind IS NOT NEW.kind
  OR OLD.payload_json IS NOT NEW.payload_json
  OR OLD.ts IS NOT NEW.ts
  OR OLD.tool_use_id IS NOT NEW.tool_use_id
BEGIN
  UPDATE session_event_revisions
  SET revision = revision + 1
  WHERE session_id = NEW.session_id;

  UPDATE events
  SET change_revision = (
    SELECT revision
    FROM session_event_revisions
    WHERE session_id = NEW.session_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER session_event_revisions_session_ai
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_event_revisions (session_id, revision, rebuild_after_revision)
  VALUES (NEW.id, 0, 0);
END;

CREATE TRIGGER summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content)
  VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER summaries_au AFTER UPDATE OF content ON summaries
WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content)
  VALUES('delete', old.id, old.content);
  INSERT INTO summaries_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER token_usage_daily_after_delete
AFTER DELETE ON token_usage
BEGIN
  UPDATE token_usage_daily_state
     SET source_revision = source_revision + 1
   WHERE singleton = 1;
  INSERT INTO token_usage_daily_dirty_days(day)
  SELECT date(OLD.ts/1000, 'unixepoch', 'localtime')
   WHERE date(OLD.ts/1000, 'unixepoch', 'localtime') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM token_usage_daily_dirty_days
        WHERE day = date(OLD.ts/1000, 'unixepoch', 'localtime')
     );
END;

CREATE TRIGGER token_usage_daily_after_insert
AFTER INSERT ON token_usage
BEGIN
  UPDATE token_usage_daily_state
     SET source_revision = source_revision + 1
   WHERE singleton = 1;
  INSERT INTO token_usage_daily_dirty_days(day)
  SELECT date(NEW.ts/1000, 'unixepoch', 'localtime')
   WHERE date(NEW.ts/1000, 'unixepoch', 'localtime') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM token_usage_daily_dirty_days
        WHERE day = date(NEW.ts/1000, 'unixepoch', 'localtime')
     );
END;

CREATE TRIGGER token_usage_daily_after_update
AFTER UPDATE ON token_usage
WHEN OLD.session_id            IS NOT NEW.session_id
  OR OLD.agent_id              IS NOT NEW.agent_id
  OR OLD.message_id            IS NOT NEW.message_id
  OR OLD.model_raw             IS NOT NEW.model_raw
  OR OLD.model_bucket          IS NOT NEW.model_bucket
  OR OLD.total_tokens          IS NOT NEW.total_tokens
  OR OLD.input_tokens          IS NOT NEW.input_tokens
  OR OLD.output_tokens         IS NOT NEW.output_tokens
  OR OLD.reasoning_tokens      IS NOT NEW.reasoning_tokens
  OR OLD.cache_read_tokens     IS NOT NEW.cache_read_tokens
  OR OLD.cache_creation_tokens IS NOT NEW.cache_creation_tokens
  OR OLD.metric_scope          IS NOT NEW.metric_scope
  OR OLD.ts                    IS NOT NEW.ts
BEGIN
  UPDATE token_usage_daily_state
     SET source_revision = source_revision + 1
   WHERE singleton = 1;
  INSERT INTO token_usage_daily_dirty_days(day)
  SELECT date(OLD.ts/1000, 'unixepoch', 'localtime')
   WHERE date(OLD.ts/1000, 'unixepoch', 'localtime') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM token_usage_daily_dirty_days
        WHERE day = date(OLD.ts/1000, 'unixepoch', 'localtime')
     );
  INSERT INTO token_usage_daily_dirty_days(day)
  SELECT date(NEW.ts/1000, 'unixepoch', 'localtime')
   WHERE date(NEW.ts/1000, 'unixepoch', 'localtime') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM token_usage_daily_dirty_days
        WHERE day = date(NEW.ts/1000, 'unixepoch', 'localtime')
     );
END;

INSERT INTO token_usage_daily_state (singleton, source_revision, projection_revision, timezone_fingerprint, full_rebuild_required) VALUES (1, 0, -1, NULL, 1);
