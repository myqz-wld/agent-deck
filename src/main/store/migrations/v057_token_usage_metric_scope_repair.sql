-- Translators inserted post-v052 rows with the legacy all-metrics default even when an optional
-- provider field was absent. Remove only null metric bits for non-Grok additive observations.
-- Preserve Grok's scoped NULLs: cumulative deltas can be genuinely unknown rather than absent.
UPDATE token_usage
SET metric_scope =
      (metric_scope & 1)
    | CASE WHEN (metric_scope & 2) != 0 AND input_tokens IS NOT NULL THEN 2 ELSE 0 END
    | CASE WHEN (metric_scope & 4) != 0 AND output_tokens IS NOT NULL THEN 4 ELSE 0 END
    | CASE WHEN (metric_scope & 8) != 0 AND reasoning_tokens IS NOT NULL THEN 8 ELSE 0 END
    | CASE WHEN (metric_scope & 16) != 0 AND cache_read_tokens IS NOT NULL THEN 16 ELSE 0 END
    | CASE WHEN (metric_scope & 32) != 0 AND cache_creation_tokens IS NOT NULL THEN 32 ELSE 0 END
WHERE agent_id != 'grok-build'
  AND (
       ((metric_scope & 2) != 0 AND input_tokens IS NULL)
    OR ((metric_scope & 4) != 0 AND output_tokens IS NULL)
    OR ((metric_scope & 8) != 0 AND reasoning_tokens IS NULL)
    OR ((metric_scope & 16) != 0 AND cache_read_tokens IS NULL)
    OR ((metric_scope & 32) != 0 AND cache_creation_tokens IS NULL)
  );
