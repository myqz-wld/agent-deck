-- v036: repair GPT token-usage buckets truncated by the pre-v036 prefix parser.
--
-- The old normalizer parsed only the `gpt-<major>[.<minor>]` prefix, so distinct model ids such as
-- `gpt-5.6-sol`, `gpt-5.4-mini`, and custom provider slugs were stored in the bare version bucket.
-- Rebuild affected GPT buckets from model_raw while preserving the established aggregation policy:
--   - only approved terminal context / thinking / reasoning markers are stripped, repeatedly;
--   - semantic/provider suffixes remain part of the bucket;
--   - bare hyphen versions such as gpt-5-5 keep their canonical gpt-5.5 bucket.
--
-- This migration intentionally does not rewrite Claude rows. v036 has measured historical evidence
-- for GPT truncation only; applying the new Claude grammar retroactively would broaden this repair
-- without observed affected rows. model_raw remains available for a later evidence-backed repair.

WITH RECURSIVE
variant_suffixes(suffix) AS (
  VALUES
    ('[1m]'),
    ('-1m'),
    ('-thinking'),
    ('-minimal'),
    ('-medium'),
    ('-xhigh'),
    ('-ultra'),
    ('-high'),
    ('-low'),
    ('-max')
),
stripped(id, core) AS (
  SELECT id, trim(lower(trim(model_raw)), '-_ ')
  FROM token_usage
  WHERE trim(lower(trim(model_raw)), '-_ ') LIKE 'gpt-%'

  UNION ALL

  SELECT
    stripped.id,
    rtrim(
      substr(stripped.core, 1, length(stripped.core) - length(variant_suffixes.suffix)),
      '-_ '
    )
  FROM stripped
  JOIN variant_suffixes
    ON substr(stripped.core, -length(variant_suffixes.suffix)) = variant_suffixes.suffix
),
normalized(id, core) AS (
  SELECT stripped.id, stripped.core
  FROM stripped
  WHERE NOT EXISTS (
    SELECT 1
    FROM variant_suffixes
    WHERE substr(stripped.core, -length(variant_suffixes.suffix)) = variant_suffixes.suffix
  )
)
UPDATE token_usage
SET model_bucket = (
  SELECT normalized.core
  FROM normalized
  WHERE normalized.id = token_usage.id
)
WHERE EXISTS (
  SELECT 1
  FROM normalized
  WHERE normalized.id = token_usage.id
    AND normalized.core <> token_usage.model_bucket
    -- gpt-5-5 is an alternate spelling of the already-canonical gpt-5.5 bucket.
    AND normalized.core <> replace(token_usage.model_bucket, '.', '-')
);
