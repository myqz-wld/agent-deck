export const WORKTREE_TRANSITION_CONTINUATION =
  'The session working directory transition is complete. Continue the current task from the existing conversation and tool result.';

export const WORKTREE_TRANSITION_FAILURE_CONTINUATION =
  'The working directory transition did not complete. Continue the current task from the restored working directory.';

/** Durable discriminator for marker-only exits that can safely fall back to their legacy marker. */
export const LEGACY_EXIT_CONTINUATION_KEY_PREFIX =
  'worktree-cwd:legacy-exit:';

export function isLegacyExitContinuationKey(value: string): boolean {
  return value.startsWith(LEGACY_EXIT_CONTINUATION_KEY_PREFIX);
}
