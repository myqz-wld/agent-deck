-- v035: expose Codex reasoning output tokens in token_usage daily statistics.
--
-- Existing output_tokens semantics are intentionally preserved: Codex output_tokens already
-- includes reasoningOutputTokens for header / rate continuity. reasoning_tokens stores the
-- reasoning subset separately so the Data tab can show it as its own column.
-- Older rows keep reasoning_tokens = 0 because pre-v035 Codex output totals cannot be split
-- retroactively.

ALTER TABLE token_usage
  ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
