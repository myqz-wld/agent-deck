-- v054 — durable cross-session message delivery lease generation
--
-- A watcher claim snapshots the destination and increments delivery_generation atomically.
-- Every claimed completion compares both fields, so a stale callback cannot finalize a later
-- claim generation or a handoff-retargeted pending envelope.
ALTER TABLE agent_deck_messages
  ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_generation >= 0);

ALTER TABLE agent_deck_messages
  ADD COLUMN delivery_lease_to_session_id TEXT;
