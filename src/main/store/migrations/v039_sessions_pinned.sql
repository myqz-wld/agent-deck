-- v039: persistent session pin state.
--
-- NULL means unpinned. A non-NULL value records when the session was pinned and must be a
-- nonnegative epoch timestamp. The partial indexes cover the three pin-aware hot paths without
-- duplicating the adapter/spawn-filter combinations owned by v034.

ALTER TABLE sessions
ADD COLUMN pinned_at INTEGER CHECK (pinned_at IS NULL OR pinned_at >= 0);

-- Idle lifecycle scans select only unarchived, unpinned rows in one source lifecycle.
CREATE INDEX idx_sessions_unpinned_live_lifecycle_last_event
ON sessions(lifecycle, last_event_at)
WHERE archived_at IS NULL AND pinned_at IS NULL;

-- The real-time UI orders the complete live set by pin timestamp before recency and stable id.
CREATE INDEX idx_sessions_live_pinned_last_event
ON sessions(pinned_at DESC, last_event_at DESC, id ASC)
WHERE archived_at IS NULL AND lifecycle IN ('active', 'dormant');

-- Retention GC walks only unpinned history from oldest to newest with a stable id tie-breaker.
CREATE INDEX idx_sessions_unpinned_history_last_event
ON sessions(last_event_at ASC, id ASC)
WHERE pinned_at IS NULL AND (lifecycle = 'closed' OR archived_at IS NOT NULL);
