import { randomUUID } from 'node:crypto';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { worktreeTransitionCoordinator } from '@main/session/worktree-transition/coordinator';
import {
  cleanupStructuredWorktree,
  preflightStructuredWorktreeExit,
} from '@main/session/worktree-transition/git-cleanup';
import {
  worktreeTransitionId,
  type WorktreeTransitionRecord,
} from '@main/session/worktree-transition/types';
import { LEGACY_EXIT_CONTINUATION_KEY_PREFIX } from '@main/session/worktree-transition/constants';
import log from '@main/utils/logger';
import {
  err,
  structuredOk,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ExitWorktreeArgs, ExitWorktreeResult } from '../schemas';
import {
  prepareLegacyWorktreeExit,
  _internalIsError as isLegacyExitError,
  type ExitWorktreeDeps,
} from './exit-worktree-impl';

const logger = log.scope('worktree-exit');
const SLOW_HANDLER_DIAGNOSTIC_MS = 5_000;

type ExitHandlerStage =
  | 'transition-lookup'
  | 'structured-preflight'
  | 'cleanup-retry'
  | 'legacy-preflight'
  | 'legacy-adoption'
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

/**
 * 测试 inject seam:test 通过 depsOverride.implDeps 注入 mock git/fs/sessionRepo 走纯 in-memory。
 * 默认 handler 自己注入 sessionRepo 的真实 callerMarker / callerCwd /
 * clearCwdReleaseMarker 调用,impl 其他 fs/git deps fallback impl 的 DEFAULT_DEPS。
 */
export interface ExitWorktreeHandlerDeps {
  implDeps?: ExitWorktreeDeps;
}

/**
 * 默认 sessionRepo seam:callerMarker / callerCwd 反查 sessionRepo;
 * clearCwdReleaseMarker 写 DB null。与 archive-plan / enter-worktree handler 同款 —
 * sessionRepo 在 handler 层 import 触发 electron load OK,但 impl 不能 import。
 */
const DEFAULT_SESSION_DEPS: Required<
  Pick<
    ExitWorktreeDeps,
    'callerMarker' | 'callerCwd' | 'clearCwdReleaseMarker'
  >
> = {
  callerMarker: (sid) => sessionRepo.get(sid)?.cwdReleaseMarker ?? null,
  callerCwd: (sid) => sessionRepo.get(sid)?.cwd ?? null,
  clearCwdReleaseMarker: (sid) => sessionRepo.clearCwdReleaseMarker(sid),
};

export const exitWorktreeHandler = withMcpGuard(
  'exit_worktree',
  async (
    args: ExitWorktreeArgs,
    ctx: HandlerContext,
    handlerDeps?: ExitWorktreeHandlerDeps,
  ) => {
    const tracker = createStageTracker();
    const mergedDeps: ExitWorktreeDeps = {
      ...DEFAULT_SESSION_DEPS,
      ...handlerDeps?.implDeps,
    };
    const callerSessionId = ctx.caller.callerSessionId;
    try {
      const transition = worktreeTransitionRepo.get(callerSessionId);
      if (transition && transition.phase !== 'cleared') {
        if (
          transition.direction === 'exit' &&
          transition.phase === 'exit_waiting_tool_result'
        ) {
          return structuredOk({
            transitionId: worktreeTransitionId(transition),
            direction: 'exit',
            state: 'waiting-tool-result',
            effectiveFrom: 'automatic-next-turn',
            worktreePath: transition.worktreePath,
            workBranch: transition.workBranch || null,
          } satisfies ExitWorktreeResult);
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
              lastError: cleanup.branchError
                ? `Worktree removed, but branch deletion failed: ${cleanup.branchError}`
                : null,
            });
            return structuredOk({
              transitionId: worktreeTransitionId(cleared),
              direction: 'exit',
              state: 'completed-cleanup',
              effectiveFrom: 'already-effective',
              worktreePath: cleared.worktreePath,
              workBranch: cleared.workBranch || null,
              branchDeleted: cleanup.branchDeleted,
              worktreeRemoved: cleanup.worktreeRemoved,
              markerCleared: true,
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
              { markerCleared: false },
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
            args.discardChanges
              ? 'The structured worktree lease and marker were retained.'
              : 'Commit, stash, copy, or otherwise preserve changes before retrying. Pass discardChanges=true only with explicit user authorization.',
            { markerCleared: false },
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
        let exiting;
        try {
          exiting = worktreeTransitionRepo.beginExitPreflight(
            callerSessionId,
            transition.generation,
            {
              toolUseId,
              continuationKey: `worktree-cwd:${randomUUID()}`,
              discardChanges: args.discardChanges === true,
              deleteBranch: args.deleteBranch === true,
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
            'structured',
          );
          return armError(error);
        }

        return waitingResult(exiting);
      }

      tracker.set('legacy-preflight');
      const prepared = await prepareLegacyWorktreeExit(
        {
          callerSessionId,
          worktreePathOverride: args.worktreePath,
          discardChanges: args.discardChanges,
          deleteBranch: args.deleteBranch,
        },
        mergedDeps,
      );
      if (isLegacyExitError(prepared)) {
        const extras =
          prepared.markerCleared !== undefined
            ? { markerCleared: prepared.markerCleared }
            : undefined;
        return err(prepared.error, prepared.hint, extras);
      }
      if (prepared.kind === 'missing') {
        return structuredOk({
          transitionId: null,
          direction: 'exit',
          state: 'completed-legacy',
          effectiveFrom: 'already-effective',
          worktreePath: prepared.worktreePath,
          workBranch: null,
          branchDeleted: false,
          worktreeRemoved: false,
          markerCleared: prepared.markerCleared,
        } satisfies ExitWorktreeResult);
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

      tracker.set('legacy-adoption');
      let adopted: WorktreeTransitionRecord | null = null;
      try {
        adopted = worktreeTransitionRepo.adoptLegacyExit({
          sessionId: callerSessionId,
          expectedMarker: prepared.expectedMarker,
          originalCwd: prepared.originalCwd,
          mainRepo: prepared.mainRepo,
          worktreePath: prepared.worktreePath,
          workBranch: prepared.workBranch,
          baseBranch: prepared.baseBranch,
          baseCommit: prepared.baseCommit,
          toolUseId,
          continuationKey:
            `${LEGACY_EXIT_CONTINUATION_KEY_PREFIX}${randomUUID()}`,
          discardChanges: args.discardChanges === true,
          deleteBranch: args.deleteBranch === true,
          requestedAt: Date.now(),
        });
        worktreeTransitionCoordinator.bindToolInvocation(
          callerSessionId,
          toolUseId,
          adopted.generation,
        );
        tracker.set('transition-arm');
        worktreeTransitionCoordinator.arm(adopted);
        adopted = worktreeTransitionRepo.compareAndSetPhase({
          sessionId: callerSessionId,
          generation: adopted.generation,
          expected: 'exit_preflight',
          next: 'exit_waiting_tool_result',
          updatedAt: Date.now(),
        });
      } catch (error) {
        if (adopted) {
          await rollbackFailedArm(
            callerSessionId,
            toolUseId,
            adopted.generation,
            error,
            'legacy',
          );
        } else {
          worktreeTransitionCoordinator.releaseToolInvocation(
            callerSessionId,
            toolUseId,
          );
        }
        return armError(error);
      }
      return waitingResult(adopted);
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
    workBranch: record.workBranch || null,
  } satisfies ExitWorktreeResult);
}

function armError(error: unknown) {
  return err(
    `exit_worktree could not arm the automatic cwd transition: ${
      error instanceof Error ? error.message : String(error)
    }`,
    'The worktree was not removed. Its lease and marker were retained; retry from the active provider turn.',
    { markerCleared: false },
  );
}

async function rollbackFailedArm(
  callerSessionId: string,
  toolUseId: string,
  generation: number,
  error: unknown,
  source: 'structured' | 'legacy',
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
    const lastError = error instanceof Error ? error.message : String(error);
    if (source === 'legacy') {
      worktreeTransitionRepo.releaseLegacyExitAdoption({
        sessionId: callerSessionId,
        generation: current.generation,
        expected: 'exit_preflight',
        updatedAt: Date.now(),
        lastError,
      });
    } else {
      worktreeTransitionRepo.compareAndSetPhase({
        sessionId: callerSessionId,
        generation: current.generation,
        expected: 'exit_preflight',
        next: 'active',
        updatedAt: Date.now(),
        lastError,
      });
    }
  } catch {
    // The primary arming failure remains authoritative.
  }
}
