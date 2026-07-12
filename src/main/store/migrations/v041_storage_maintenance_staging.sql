-- V41: staged event-search and file-snapshot storage compaction.
--
-- This migration is intentionally DDL-only. The production-size copy needs tens of seconds for
-- either full backfill, so startup only creates empty targets, dual-write triggers, and durable
-- cursors. `StorageMaintenanceScheduler` owns resumable slices after bootstrap.

CREATE TABLE storage_maintenance_state (
  task TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
  upper_bound INTEGER NOT NULL DEFAULT 0 CHECK(upper_bound >= 0),
  batch_size INTEGER NOT NULL CHECK(batch_size BETWEEN 1 AND 500),
  last_error TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- A view avoids storing another ~159MiB text copy without adding a generated column to `events`:
-- many hot reads use SELECT *, which would otherwise compute and return the projection even when
-- history search is not involved. The CASE guard keeps malformed historical JSON searchable as raw
-- text instead of aborting a maintenance batch.
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

-- Product SQLite 3.49 supports contentless-delete tables: rowid DELETE/UPDATE is safe without a
-- second materialized document table. FTS5 rejects columnsize=0 together with contentless_delete,
-- so this candidate keeps the small token-count metadata (included in the 372.4MiB copy benchmark).
CREATE VIRTUAL TABLE event_search_fts_v1 USING fts5(
  search_text,
  content='',
  contentless_delete=1,
  tokenize='trigram case_sensitive 1'
);

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

INSERT INTO storage_maintenance_state
  (task, phase, cursor, upper_bound, batch_size, last_error, updated_at)
SELECT 'event-search-v1', 'backfill', 0, COALESCE(MAX(id), 0), 50, NULL,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM events;

CREATE TABLE file_snapshot_blobs (
  digest BLOB PRIMARY KEY CHECK(length(digest) = 32),
  codec TEXT NOT NULL CHECK(codec = 'deflate-raw-1'),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0),
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes >= 0),
  data BLOB NOT NULL
) WITHOUT ROWID;

ALTER TABLE file_changes ADD COLUMN before_snapshot_hash BLOB
  REFERENCES file_snapshot_blobs(digest) ON DELETE RESTRICT;
ALTER TABLE file_changes ADD COLUMN after_snapshot_hash BLOB
  REFERENCES file_snapshot_blobs(digest) ON DELETE RESTRICT;

-- Do not create the two partial reference indexes here. Even though every existing hash is NULL,
-- SQLite cold-scans the 289MiB legacy file_changes table to build each index (733ms measured on the
-- production copy). They are created transactionally only at a clean shutdown after legacy text is
-- verified and cleared. Blob GC remains parked until that durable index gate is complete.

-- Cascades only enqueue candidate digests. The maintenance scheduler performs two indexed probes
-- before deleting a blob; no correlated OR scan and no expensive per-row blob deletion runs here.
CREATE TABLE file_snapshot_gc_queue (
  digest BLOB PRIMARY KEY CHECK(length(digest) = 32),
  queued_at INTEGER NOT NULL
) WITHOUT ROWID;

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

INSERT INTO storage_maintenance_state
  (task, phase, cursor, upper_bound, batch_size, last_error, updated_at)
SELECT 'file-snapshot-blobs-v1', 'backfill', 0, COALESCE(MAX(id), 0), 8, NULL,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM file_changes;
