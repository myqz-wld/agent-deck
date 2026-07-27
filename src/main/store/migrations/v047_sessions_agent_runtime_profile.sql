ALTER TABLE sessions ADD COLUMN agent_profile_name TEXT;
ALTER TABLE sessions ADD COLUMN agent_profile_source TEXT
  CHECK (
    agent_profile_source IS NULL OR
    agent_profile_source IN ('bundled', 'project', 'user', 'plugin')
  );
ALTER TABLE sessions ADD COLUMN agent_plugin_dir TEXT;
