-- Persist the Grok Build native sandbox profile requested for an ACP child.
-- NULL delegates to Grok's own user/project/env/managed configuration precedence.
ALTER TABLE sessions ADD COLUMN grok_sandbox TEXT;
