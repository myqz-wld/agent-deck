-- Preserve "not reported" as NULL instead of fabricating zero. Also retain an
-- exact provider total when one is returned (currently Grok ACP/extension).
CREATE TABLE token_usage_v051 (
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

INSERT INTO token_usage_v051 (
  id, session_id, agent_id, message_id, model_raw, model_bucket,
  total_tokens, input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_creation_tokens, metric_scope, ts
)
SELECT
  id, session_id, agent_id, message_id, model_raw, model_bucket,
  NULL,
  CASE
    -- Every pre-v051 translator used `?? 0` for at least one provider shape. The old schema did
    -- not retain presence, so a stored zero cannot prove that the provider reported zero.
    WHEN input_tokens = 0 THEN NULL
    ELSE input_tokens
  END,
  CASE
    WHEN output_tokens = 0 THEN NULL
    ELSE output_tokens
  END,
  -- v035 explicitly initialized pre-reasoning rows to zero even though no provider value existed.
  CASE WHEN reasoning_tokens = 0 THEN NULL ELSE reasoning_tokens END,
  -- v028 forced all missing cache dimensions to zero. True zero and missing are no longer
  -- distinguishable, so retaining zero would make an unsupported precision claim.
  CASE WHEN cache_read_tokens = 0 THEN NULL ELSE cache_read_tokens END,
  CASE WHEN cache_creation_tokens = 0 THEN NULL ELSE cache_creation_tokens END,
  63,
  ts
FROM token_usage;

DROP TABLE token_usage;
ALTER TABLE token_usage_v051 RENAME TO token_usage;

CREATE UNIQUE INDEX uq_token_usage_message_id
  ON token_usage(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_token_usage_ts ON token_usage(ts);
CREATE INDEX idx_token_usage_bucket_ts ON token_usage(model_bucket, ts);
