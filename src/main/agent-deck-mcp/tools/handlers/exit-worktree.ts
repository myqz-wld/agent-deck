import { randomUUID } from 'node:crypto';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { worktreeTransitionCoordinator } from '@main/session/worktree-transition/coordinator';
import {
  cleanupStructuredWorktree,
  preflightStructuredWorktreeExit,
} from '@main/session/worktree-transition/git-cleanup';
import {
  DirtyWorktreeError,
  UnreferencedWorktreeHeadError,
} from '@main/session/worktree-transition/git-safety';
import {
  worktreeTransitionId,
  type WorktreeTransitionRecord,
} from '@main/session/worktree-transition/types';
import log from '@main/utils/logger';
import {
  err,
  structuredOk,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ExitWorktreeArgs, ExitWorktreeResult } from '../schemas';

const logger = log.scope('worktree-exit');
const SLOW_HANDLER_DIAGNOSTIC_MS = 5_000;

type ExitHandlerStage =
  | 'transition-lookup'
  | 'structured-preflight'
  | 'cleanup-retry'
  | 'transition-arm';

function createStageTracker(): {
  set(stage: ExitHandlerStage): void;
  close(): void;
} {
  const startedAt = Date.now();
  let stage: ExitHandlerStage = 'transition-lookup';
  let closed = false;
  const timer = setTimeout(() => {
    if (closed) return;
    logger.warn('[exit_worktree] handler has not returned', {
      stage,
      elapsedMs: Date.now() - startedAt,
    });
  }, SLOW_HANDLER_DIAGNOSTIC_MS);
  timer.unref();
  return {
    set(next) {
      stage = next;
    },
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

export const exitWorktreeHandler = withMcpGuard(
  'exit_worktree',
  async (args: ExitWorktreeArgs, ctx: HandlerContext) => {
    const tracker = createStageTracker();
    const callerSessionId = ctx.caller.callerSessionId;
    try {
      const transition = worktreeTransitionRepo.get(callerSessionId);
      if (!transition || transition.phase === 'cleared') {
        return err(
          `session ${callerSessionId} has no active worktree lease`,
          'Call enter_worktree first. exit_worktree only operates on the structured lease owned by the caller session.',
        );
      }

      if (
        transition.direction === 'exit' &&
        transition.phase === 'exit_waiting_tool_result'
      ) {
        return waitingResult(transition);
      }

      if (transition.phase === 'cleanup_pending') {
        tracker.set('cleanup-retry');
        if (!transition.continuationDelivered) {
          return err(
            `worktree transition ${worktreeTransitionId(
              transition,
            )} is still delivering its automatic continuation`,
            'Retry after the pending continuation settles.',
          );
        }
        try {
          const cleanup = await cleanupStructuredWorktree(transition);
          const cleared = worktreeTransitionRepo.compareAndSetPhase({
            sessionId: callerSessionId,
            generation: transition.generation,
            expected: 'cleanup_pending',
            next: 'cleared',
            updatedAt: Date.now(),
            lastError: null,
          });
          return structuredOk({
            transitionId: worktreeTransitionId(cleared),
            direction: 'exit',
            state: 'completed-cleanup',
            effectiveFrom: 'already-effective',
            worktreePath: cleared.worktreePath,
            worktreeRemoved: cleanup.worktreeRemoved,
          } satisfies ExitWorktreeResult);
        } catch (error) {
          worktreeTransitionRepo.setLastError(
            callerSessionId,
            transition.generation,
            error instanceof Error ? error.message : String(error),
            Date.now(),
          );
          return err(
            `worktree cleanup retry failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'The session already runs from the original cwd. Preserve the worktree and retry exit_worktree after resolving the reported cleanup condition.',
          );
        }
      }

      if (transition.phase !== 'active') {
        return err(
          `worktree transition ${worktreeTransitionId(
            transition,
          )} is in phase ${transition.phase}`,
          'Retry after the current automatic cwd transition settles.',
        );
      }

      tracker.set('structured-preflight');
      try {
        await preflightStructuredWorktreeExit(transition, {
          worktreePathOverride: args.worktreePath,
          discardChanges: args.discardChanges === true,
        });
      } catch (error) {
        return err(
          error instanceof Error ? error.message : String(error),
          preflightRecoveryHint(error, args.discardChanges === true),
        );
      }

      let toolUseId: string;
      try {
        toolUseId = worktreeTransitionCoordinator.reserveToolInvocation(
          callerSessionId,
          'exit',
        );
      } catch (error) {
        return err(
          error instanceof Error ? error.message : String(error),
          'The tool must be invoked from the active in-app provider turn so Agent Deck can correlate its exact tool result.',
        );
      }

      tracker.set('transition-arm');
      let exiting: WorktreeTransitionRecord;
      try {
        exiting = worktreeTransitionRepo.beginExitPreflight(
          callerSessionId,
          transition.generation,
          {
            toolUseId,
            continuationKey: `worktree-cwd:${randomUUID()}`,
            discardChanges: args.discardChanges === true,
            requestedAt: Date.now(),
          },
        );
        worktreeTransitionCoordinator.bindToolInvocation(
          callerSessionId,
          toolUseId,
          exiting.generation,
        );
        worktreeTransitionCoordinator.arm(exiting);
        exiting = worktreeTransitionRepo.compareAndSetPhase({
          sessionId: callerSessionId,
          generation: exiting.generation,
          expected: 'exit_preflight',
          next: 'exit_waiting_tool_result',
          updatedAt: Date.now(),
        });
      } catch (error) {
        await rollbackFailedArm(
          callerSessionId,
          toolUseId,
          transition.generation,
          error,
        );
        return armError(error);
      }

      return waitingResult(exiting);
    } finally {
      tracker.close();
    }
  },
);

function waitingResult(record: WorktreeTransitionRecord) {
  return structuredOk({
    transitionId: worktreeTransitionId(record),
    direction: 'exit',
    state: 'waiting-tool-result',
    effectiveFrom: 'automatic-next-turn',
    worktreePath: record.worktreePath,
  } satisfies ExitWorktreeResult);
}

function preflightRecoveryHint(error: unknown, discardChanges: boolean): string {
  if (error instanceof DirtyWorktreeError) {
    return 'Commit, stash, copy, or otherwise preserve the listed changes, then retry. Pass discardChanges=true only with explicit user authorization to permanently remove them.';
  }
  if (error instanceof UnreferencedWorktreeHeadError) {
    return 'Create a local branch or tag that contains the reported HEAD commit, then retry. discardChanges does not authorize losing commits.';
  }
  return discardChanges
    ? 'The lease, worktree, and every Git ref were retained. Resolve the reported identity or reference condition, then retry.'
    : 'The lease, worktree, and every Git ref were retained. Resolve the reported condition, preserve any needed work, then retry.';
}

function armError(error: unknown) {
  return err(
    `exit_worktree could not arm the automatic cwd transition: ${
      error instanceof Error ? error.message : String(error)
    }`,
    'The worktree was not removed. Its structured lease was retained; retry from the active provider turn.',
  );
}

async function rollbackFailedArm(
  callerSessionId: string,
  toolUseId: string,
  generation: number,
  error: unknown,
): Promise<void> {
  worktreeTransitionCoordinator.releaseToolInvocation(
    callerSessionId,
    toolUseId,
  );
  const current = worktreeTransitionRepo.get(callerSessionId);
  if (
    !current ||
    current.generation !== generation ||
    current.phase !== 'exit_preflight'
  ) {
    return;
  }
  try {
    await worktreeTransitionCoordinator.releaseAbortedPreparation(current);
    worktreeTransitionRepo.compareAndSetPhase({
      sessionId: callerSessionId,
      generation: current.generation,
      expected: 'exit_preflight',
      next: 'active',
      updatedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // The primary arming failure remains authoritative.
  }
}
