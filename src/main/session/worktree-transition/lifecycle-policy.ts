import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { isDbInitialized } from '@main/store/db';

/**
 * A structured lease is the only durable copy of the original cwd and cleanup parameters.
 * Closing or archiving may stop its runtime, but must not discard that recovery information.
 * Legacy marker-only sessions keep their historical clear-on-close behavior.
 */
export function mayClearLegacyWorktreeMarker(sessionId: string): boolean {
  if (!isDbInitialized()) return true;
  const transition = worktreeTransitionRepo.get(sessionId);
  return !transition || transition.phase === 'cleared';
}

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
