-- Durable source-to-successor routing for replies that outlive an in-memory handoff window or app
-- restart. Deliberately no session FK: an old wire anchor must remain routable after source cleanup.
CREATE TABLE session_handoff_aliases (
  source_session_id    TEXT PRIMARY KEY,
  successor_session_id TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  CHECK (source_session_id <> successor_session_id)
);

CREATE INDEX idx_session_handoff_aliases_successor
  ON session_handoff_aliases(successor_session_id);
