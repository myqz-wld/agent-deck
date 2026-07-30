CREATE TABLE worktree_cwd_transitions (
  session_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL DEFAULT 1 CHECK (format_version = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  direction TEXT NOT NULL CHECK (direction IN ('enter', 'exit')),
  phase TEXT NOT NULL CHECK (
    phase IN (
      'creating',
      'enter_waiting_tool_result',
      'interrupting_enter_turn',
      'switching_to_worktree',
      'active',
      'exit_preflight',
      'exit_waiting_tool_result',
      'interrupting_exit_turn',
      'restoring_original_cwd',
      'cleanup_pending',
      'cleared'
    )
  ),
  original_cwd TEXT NOT NULL,
  target_cwd TEXT NOT NULL,
  main_repo TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  work_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  tool_use_id TEXT,
  continuation_key TEXT NOT NULL,
  continuation_delivered INTEGER NOT NULL DEFAULT 0
    CHECK (continuation_delivered IN (0, 1)),
  discard_changes INTEGER NOT NULL DEFAULT 0 CHECK (discard_changes IN (0, 1)),
  delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (delete_branch IN (0, 1)),
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);

CREATE UNIQUE INDEX idx_worktree_cwd_transitions_tool_use
  ON worktree_cwd_transitions(session_id, generation, tool_use_id)
  WHERE tool_use_id IS NOT NULL;

CREATE INDEX idx_worktree_cwd_transitions_phase
  ON worktree_cwd_transitions(phase, updated_at);

CREATE INDEX idx_worktree_cwd_transitions_path
  ON worktree_cwd_transitions(worktree_path, phase);

CREATE TABLE worktree_cwd_transition_inputs (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (session_id, generation, sequence)
);

CREATE INDEX idx_worktree_cwd_transition_inputs_pending
  ON worktree_cwd_transition_inputs(session_id, generation, delivered_at, sequence);
