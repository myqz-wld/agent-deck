-- v048: repair Codex output totals that double-counted the exact reasoning subset.
--
-- Since v035, Codex rows store reasoning_output_tokens separately. The old adapter persisted
-- output_tokens + reasoning_output_tokens even though Codex output_tokens already includes that
-- reasoning subset. Only rows with a recorded reasoning value can be repaired exactly; older
-- rows whose reasoning_tokens defaulted to zero are intentionally left untouched.

UPDATE token_usage
SET output_tokens = max(0, output_tokens - reasoning_tokens)
WHERE agent_id = 'codex-cli'
  AND reasoning_tokens > 0;
