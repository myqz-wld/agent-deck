-- Standard ACP Usage counters are cumulative across the native session. Keep
-- the last exact snapshot so recovery can continue calculating per-turn deltas
-- instead of counting the complete session history again.
ALTER TABLE sessions ADD COLUMN grok_usage_watermark TEXT;
