ALTER TABLE sessions ADD COLUMN runtime_provider TEXT;

UPDATE sessions
SET agent_id = 'claude-code',
    runtime_provider = 'deepseek'
WHERE agent_id = 'deepseek-claude-code';
