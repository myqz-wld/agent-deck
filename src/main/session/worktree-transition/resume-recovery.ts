import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import log from '@main/utils/logger';
import { recoverWorktreeTransition } from './recovery';

const logger = log.scope('worktree-transition-resume');
let unsubscribe: (() => void) | null = null;

/**
 * Resume a transition that startup intentionally left untouched while its session was closed or
 * archived. The session-upserted signal covers explicit reactivate/unarchive and SDK user-send
 * revival without coupling lifecycle code back to the transition coordinator.
 */
export function startWorktreeTransitionResumeRecovery(): void {
  unsubscribe?.();
  unsubscribe = eventBus.on('session-upserted', (session) => {
    if (session.lifecycle === 'closed' || session.archivedAt !== null) return;
    const transition = worktreeTransitionRepo.get(session.id);
    if (
      !transition ||
      transition.phase === 'active' ||
      transition.phase === 'cleared'
    ) {
      return;
    }
    queueMicrotask(() => {
      const currentSession = sessionRepo.get(session.id);
      const currentTransition = worktreeTransitionRepo.get(session.id);
      if (
        !currentSession ||
        currentSession.lifecycle === 'closed' ||
        currentSession.archivedAt !== null ||
        !currentTransition ||
        currentTransition.phase === 'active' ||
        currentTransition.phase === 'cleared'
      ) {
        return;
      }
      void recoverWorktreeTransition(session.id).catch((error) => {
        logger.warn(
          `resume recovery retained ${session.id}:${currentTransition.generation} fail-closed`,
          error,
        );
      });
    });
  });
}

export function stopWorktreeTransitionResumeRecovery(): void {
  unsubscribe?.();
  unsubscribe = null;
}
