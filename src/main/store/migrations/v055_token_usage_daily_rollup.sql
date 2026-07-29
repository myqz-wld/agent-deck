-- Persistent projection for the unbounded token_usage daily query.
--
-- Migration work is deliberately O(schema): existing rows are neither scanned nor copied.
-- The singleton starts rebuild-required, so the first unbounded read builds the projection from
-- the authoritative raw ledger inside one transaction. Bounded reads always remain raw.

CREATE TABLE token_usage_daily_rollup (
  day                         TEXT NOT NULL,
  model_bucket                TEXT NOT NULL,
  sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
  provider_total_tokens       INTEGER,
  provider_total_applicable   INTEGER NOT NULL CHECK (provider_total_applicable IN (0, 1)),
  input_tokens                INTEGER,
  input_applicable            INTEGER NOT NULL CHECK (input_applicable IN (0, 1)),
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

INSERT INTO token_usage_daily_state (
  singleton, source_revision, projection_revision, timezone_fingerprint,
  full_rebuild_required
) VALUES (1, 0, -1, NULL, 1);

CREATE TABLE token_usage_daily_dirty_days (
  day TEXT PRIMARY KEY
) WITHOUT ROWID;

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
