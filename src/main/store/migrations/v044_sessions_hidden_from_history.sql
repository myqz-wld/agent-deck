-- Internal runtime sessions (for example plan-review companions) remain available to active
-- lifecycle/event lookups but never appear in the user-facing History page.
ALTER TABLE sessions
  ADD COLUMN hidden_from_history INTEGER NOT NULL DEFAULT 0
  CHECK (hidden_from_history IN (0, 1));
