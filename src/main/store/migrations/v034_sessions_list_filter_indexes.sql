-- v034: speed up MCP list_sessions SQL pushdown filters.
--
-- list_sessions now sends spawnedByFilter and adapterFilter to the session repo
-- before output pagination. These partial indexes cover the active/dormant and
-- history query shapes while preserving last_event_at ordering for LIMIT/OFFSET.

CREATE INDEX IF NOT EXISTS idx_sessions_live_lifecycle_agent_last_event
ON sessions(lifecycle, agent_id, last_event_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_live_lifecycle_spawned_last_event
ON sessions(lifecycle, spawned_by, last_event_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_live_lifecycle_spawned_agent_last_event
ON sessions(lifecycle, spawned_by, agent_id, last_event_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_history_agent_last_event
ON sessions(agent_id, last_event_at DESC)
WHERE lifecycle = 'closed' OR archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_history_spawned_last_event
ON sessions(spawned_by, last_event_at DESC)
WHERE lifecycle = 'closed' OR archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_history_spawned_agent_last_event
ON sessions(spawned_by, agent_id, last_event_at DESC)
WHERE lifecycle = 'closed' OR archived_at IS NOT NULL;
