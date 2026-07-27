-- v051 conservatively converted ambiguous legacy zeroes to NULL, but then marked every metric as
-- applicable (63). The complete daily aggregate correctly treats an applicable NULL as unknown,
-- so one legacy zero made an otherwise populated bucket/day entirely unavailable.
--
-- Repair the providers whose historical rows were independent additive observations. A migrated
-- NULL is non-participating for that metric; a retained non-NULL provider fact remains applicable.
-- Keep the total bit applicable even when NULL so "Provider total" remains unavailable unless it
-- was actually reported for every contributing row.
--
-- Grok is intentionally excluded. Its partial rows can represent an unknown cumulative delta, so
-- NULL-within-scope remains meaningful and must not be weakened into a partial known sum.
UPDATE token_usage
SET metric_scope =
      1
    | CASE WHEN input_tokens IS NOT NULL THEN 2 ELSE 0 END
    | CASE WHEN output_tokens IS NOT NULL THEN 4 ELSE 0 END
    | CASE WHEN reasoning_tokens IS NOT NULL THEN 8 ELSE 0 END
    | CASE WHEN cache_read_tokens IS NOT NULL THEN 16 ELSE 0 END
    | CASE WHEN cache_creation_tokens IS NOT NULL THEN 32 ELSE 0 END
WHERE agent_id != 'grok-build'
  AND metric_scope = 63;
