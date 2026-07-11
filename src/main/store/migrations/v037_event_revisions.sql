-- v037: per-session event revisions for stable continuation-context checkpoints.
--
-- Legacy rows deliberately keep change_revision NULL. Their effective revision remains events.id,
-- avoiding a full-table rewrite while the cursor starts at each session's maximum legacy id.

ALTER TABLE events ADD COLUMN change_revision INTEGER;

CREATE TABLE session_event_revisions (
  session_id             TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision               INTEGER NOT NULL,
  rebuild_after_revision INTEGER NOT NULL DEFAULT 0
);

INSERT INTO session_event_revisions (session_id, revision, rebuild_after_revision)
SELECT sessions.id, COALESCE(MAX(events.id), 0), 0
FROM sessions
LEFT JOIN events ON events.session_id = sessions.id
GROUP BY sessions.id;

-- Keep these names separate from the v005 FTS events_ai/events_au/events_ad triggers.
CREATE TRIGGER session_event_revisions_session_ai
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_event_revisions (session_id, revision, rebuild_after_revision)
  VALUES (NEW.id, 0, 0);
END;

-- AFTER triggers own allocation. The self-stamp UPDATE changes only change_revision, so it cannot
-- enter the business-column trigger even when PRAGMA recursive_triggers is enabled.
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

-- During a parent-session cascade the parent row is already absent. The guard prevents the child
-- delete from touching or recreating cursor state that is itself being cascaded away.
CREATE TRIGGER session_event_revisions_event_ad
AFTER DELETE ON events
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
BEGIN
  UPDATE session_event_revisions
  SET revision = revision + 1,
      rebuild_after_revision = revision + 1
  WHERE session_id = OLD.session_id;
END;

CREATE INDEX idx_events_session_effective_revision
ON events (session_id, COALESCE(change_revision, id), id);
