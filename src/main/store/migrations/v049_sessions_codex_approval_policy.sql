-- Persist only explicit Agent Deck approval overrides. NULL means ordinary Codex
-- sessions continue to use config/provider ownership; reviewer sessions store
-- `never` so dormant recovery and app restart remain non-interactive.
ALTER TABLE sessions
ADD COLUMN codex_approval_policy TEXT
CHECK (
  codex_approval_policy IS NULL OR
  codex_approval_policy IN ('untrusted', 'on-request', 'never')
);

-- Existing reviewer rows predate the explicit approval column. Prefer the persisted Agent
-- identity, while retaining the v029 reviewer-only access fingerprint for rows created before the
-- profile identity became durable. Public/ordinary Codex sessions cannot set this access bundle.
UPDATE sessions
SET codex_approval_policy = 'never'
WHERE agent_id = 'codex-cli'
  AND (
    agent_profile_name = 'reviewer-codex'
    OR (
      network_access_enabled = 1
      AND additional_directories LIKE '%/.claude"%'
      AND additional_directories LIKE '%/.codex"%'
      AND additional_directories LIKE '%"/tmp"%'
    )
  );
