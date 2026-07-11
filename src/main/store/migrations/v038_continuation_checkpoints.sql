-- v038: validated, versioned continuation checkpoints.
--
-- Checkpoints are derived state. Source events remain complete and session deletion cascades the
-- derived rows. parent_checkpoint_id is provenance only and becomes NULL if retention removes the
-- parent generation.

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

CREATE INDEX idx_continuation_checkpoints_session_revision
  ON continuation_checkpoints(session_id, source_event_revision DESC, generation DESC);
