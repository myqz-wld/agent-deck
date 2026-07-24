-- Adapter-native work mode is independent from Claude permission_mode.
ALTER TABLE sessions
  ADD COLUMN session_mode TEXT
  CHECK (session_mode IS NULL OR session_mode IN ('default', 'plan', 'ask'));
