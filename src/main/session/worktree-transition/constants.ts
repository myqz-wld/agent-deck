export const WORKTREE_TRANSITION_CONTINUATION =
  'The session working directory transition is complete. Continue the current task from the existing conversation and tool result.';

export const WORKTREE_TRANSITION_FAILURE_CONTINUATION =
  'The working directory transition did not complete. Continue the current task from the restored working directory.';

/** Durable last-error prefix: a missing lexical path is not proof that enter rollback completed. */
export const WORKTREE_CLEANUP_UNPROVED_MARKER = 'WORKTREE_CLEANUP_UNPROVED';
