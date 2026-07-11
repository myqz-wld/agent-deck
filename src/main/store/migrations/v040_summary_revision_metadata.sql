-- v040: revision-bounded periodic summary cursors and explicit generation provenance.

ALTER TABLE summaries
ADD COLUMN source_event_revision INTEGER
CHECK(source_event_revision IS NULL OR source_event_revision >= 0);

ALTER TABLE summaries
ADD COLUMN source_rebuild_after_revision INTEGER
CHECK(
  source_rebuild_after_revision IS NULL
  OR (
    source_rebuild_after_revision >= 0
    AND source_event_revision IS NOT NULL
    AND source_rebuild_after_revision <= source_event_revision
  )
);

ALTER TABLE summaries
ADD COLUMN generation_source TEXT NOT NULL DEFAULT 'legacy'
CHECK(generation_source IN ('llm', 'assistant-fallback', 'stats-fallback', 'legacy'));

CREATE INDEX idx_summaries_session_source_revision
ON summaries(session_id, source_event_revision DESC)
WHERE source_event_revision IS NOT NULL;
