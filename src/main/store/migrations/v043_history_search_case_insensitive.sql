-- V43: make bounded event and summary trigram search ASCII case-insensitive.
--
-- Production databases must apply this migration with the offline migration tool while Agent Deck
-- is fully stopped. Rebuilding on a copy keeps the original database available for rollback until
-- the upgraded app passes its history-search smoke test. The bounded projection remains unchanged:
-- long tool output still contributes only its first and last 2,048 characters.

DROP TRIGGER IF EXISTS event_search_v1_ai;
DROP TRIGGER IF EXISTS event_search_v1_ad;
DROP TRIGGER IF EXISTS event_search_v1_au;
DROP TRIGGER IF EXISTS events_ai;
DROP TRIGGER IF EXISTS events_ad;
DROP TRIGGER IF EXISTS events_au;
DROP TRIGGER IF EXISTS summaries_ai;
DROP TRIGGER IF EXISTS summaries_ad;
DROP TRIGGER IF EXISTS summaries_au;

DROP TABLE IF EXISTS event_search_fts_v1;
CREATE VIRTUAL TABLE event_search_fts_v1 USING fts5(
  search_text,
  content='',
  contentless_delete=1,
  tokenize='trigram case_sensitive 0'
);

INSERT INTO event_search_fts_v1(rowid, search_text)
SELECT event_id, search_text FROM event_search_source_v1 ORDER BY event_id;

DROP TABLE IF EXISTS summaries_fts;
CREATE VIRTUAL TABLE summaries_fts USING fts5(
  content,
  content='summaries',
  content_rowid='id',
  tokenize='trigram case_sensitive 0'
);
INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild');

-- The raw-payload rollback index may already be an empty compatibility table, a fully maintained
-- legacy index, or absent. V43 no longer queries it, so all three states converge by dropping it.
DROP TABLE IF EXISTS events_fts;

CREATE TRIGGER event_search_v1_ai AFTER INSERT ON events BEGIN
  INSERT INTO event_search_fts_v1(rowid, search_text)
    SELECT event_id, search_text FROM event_search_source_v1 WHERE event_id = new.id;
END;

CREATE TRIGGER event_search_v1_ad AFTER DELETE ON events BEGIN
  DELETE FROM event_search_fts_v1 WHERE rowid = old.id;
END;

CREATE TRIGGER event_search_v1_au AFTER UPDATE OF payload_json ON events
WHEN old.payload_json IS NOT new.payload_json
BEGIN
  DELETE FROM event_search_fts_v1 WHERE rowid = old.id;
  INSERT INTO event_search_fts_v1(rowid, search_text)
    SELECT event_id, search_text FROM event_search_source_v1 WHERE event_id = new.id;
END;

CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content)
  VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER summaries_au AFTER UPDATE OF content ON summaries
WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content)
  VALUES('delete', old.id, old.content);
  INSERT INTO summaries_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Cancel every older staged-search phase, including retire-on-shutdown. The v43 index is already
-- fully populated and must never be backfilled or retired by the v41 maintenance state machine.
UPDATE storage_maintenance_state
   SET phase = 'complete',
       cursor = (SELECT COALESCE(MAX(id), 0) FROM events),
       upper_bound = (SELECT COALESCE(MAX(id), 0) FROM events),
       last_error = NULL,
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE task = 'event-search-v1';

INSERT INTO event_search_fts_v1(event_search_fts_v1) VALUES('integrity-check');
INSERT INTO summaries_fts(summaries_fts, rank) VALUES('integrity-check', 1);
