import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { isDbInitialized } from '@main/store/db';

/**
 * Deleting the session row would orphan or destroy the only recovery authority for its worktree.
 * Callers must settle exit/cleanup first; this is intentionally fail-closed.
 */
export function assertWorktreeTransitionAllowsDelete(
  sessionId: string,
): void {
  if (!isDbInitialized()) return;
  const transition = worktreeTransitionRepo.get(sessionId);
  if (!transition || transition.phase === 'cleared') return;
  throw new Error(
    `Cannot delete session ${sessionId} while worktree transition ` +
      `${transition.sessionId}:${transition.generation} is ${transition.phase}. ` +
      'Exit or recover the worktree transition first.',
  );
}
