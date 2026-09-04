import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import log from '@main/utils/logger';
import { recoverWorktreeTransition } from './recovery';
import { isPendingWorktreeTransition } from './state-machine';
import type { WorktreeTransitionRecord } from './types';

const logger = log.scope('worktree-transition-resume');
let unsubscribe: (() => void) | null = null;
const deferredGenerations = new Map<string, number>();

function isPending(transition: WorktreeTransitionRecord): boolean {
  return isPendingWorktreeTransition(transition.phase);
}

function isUnavailable(
  session: { lifecycle: string; archivedAt: number | null } | null,
): boolean {
  return (
    !session ||
    session.lifecycle === 'closed' ||
    session.archivedAt !== null
  );
}

function seedDeferredGenerations(): void {
  deferredGenerations.clear();
  for (const transition of worktreeTransitionRepo.listRecoverable()) {
    if (
      isPending(transition) &&
      isUnavailable(sessionRepo.get(transition.sessionId))
    ) {
      deferredGenerations.set(
        transition.sessionId,
        transition.generation,
      );
    }
  }
}

/**
 * Resume a transition that startup intentionally left untouched while its session was closed or
 * archived. The session-upserted signal covers explicit reactivate/unarchive and SDK user-send
 * revival without coupling lifecycle code back to the transition coordinator. An unavailable
 * observation is the eligibility proof: ordinary active-session upserts during a live coordinator
 * transition must never invoke crash recovery.
 */
export function startWorktreeTransitionResumeRecovery(): void {
  unsubscribe?.();
  seedDeferredGenerations();
  unsubscribe = eventBus.on('session-upserted', (session) => {
    const transition = worktreeTransitionRepo.get(session.id);
    if (!transition || !isPending(transition)) {
      deferredGenerations.delete(session.id);
      return;
    }
    if (isUnavailable(session)) {
      deferredGenerations.set(session.id, transition.generation);
      return;
    }
    const deferredGeneration = deferredGenerations.get(session.id);
    if (deferredGeneration === undefined) return;
    deferredGenerations.delete(session.id);
    if (deferredGeneration !== transition.generation) return;

    queueMicrotask(() => {
      const currentSession = sessionRepo.get(session.id);
      const currentTransition = worktreeTransitionRepo.get(session.id);
      if (
        !currentTransition ||
        currentTransition.generation !== deferredGeneration ||
        !isPending(currentTransition)
      ) {
        return;
      }
      if (isUnavailable(currentSession)) {
        deferredGenerations.set(session.id, currentTransition.generation);
        return;
      }
      void recoverWorktreeTransition(session.id).catch((error) => {
        const latest = worktreeTransitionRepo.get(session.id);
        if (
          latest &&
          latest.generation === deferredGeneration &&
          isPending(latest)
        ) {
          deferredGenerations.set(session.id, deferredGeneration);
        }
        logger.warn(
          `resume recovery retained ${session.id}:${currentTransition.generation} fail-closed`,
          error,
        );
      });
    });
  });
}

/** Test teardown seam for the process-lifetime listener and deferred generation cache. */
export function stopWorktreeTransitionResumeRecovery(): void {
  unsubscribe?.();
  unsubscribe = null;
  deferredGenerations.clear();
}
