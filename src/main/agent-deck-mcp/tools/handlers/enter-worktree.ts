import { randomUUID } from 'node:crypto';
import { sessionRepo } from '@main/store/session-repo';
import {
  worktreeTransitionRepo,
  WorktreeTransitionConflictError,
} from '@main/store/worktree-transition-repo';
import { worktreeTransitionCoordinator } from '@main/session/worktree-transition/coordinator';
import { worktreeTransitionId } from '@main/session/worktree-transition/types';
import {
  err,
  structuredOk,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { EnterWorktreeArgs, EnterWorktreeResult } from '../schemas';
import {
  createPreparedWorktree,
  prepareEnterWorktree,
  rollbackPreparedWorktree,
  _internalIsError,
  type EnterWorktreeDeps,
} from './enter-worktree-impl';

/**
 * 测试 inject seam:test 通过 depsOverride.implDeps 注入 mock git/fs/sessionRepo 走纯 in-memory。
 * 默认 handler 自己注入 sessionRepo 的真实 callerCwd / setCwdReleaseMarker 调用,impl 其他 fs/git
 * deps fallback impl 的 DEFAULT_DEPS(真 execFile / fs)。
 */
export interface EnterWorktreeHandlerDeps {
  implDeps?: EnterWorktreeDeps;
}

/**
 * 默认 sessionRepo seam:callerCwd 反查 sessionRepo.get(sid).cwd;setCwdReleaseMarker 写 DB。
 * sessionRepo 在 handler 层 import 触发 electron load OK,但 impl
 * 不能 import(让 impl test 走 deps inject 时不撞 electron)。
 */
const DEFAULT_SESSION_DEPS: Required<Pick<EnterWorktreeDeps, 'callerCwd' | 'setCwdReleaseMarker'>> = {
  callerCwd: (sid) => sessionRepo.get(sid)?.cwd ?? null,
  setCwdReleaseMarker: (sid, marker) => sessionRepo.setCwdReleaseMarker(sid, marker),
};

export const enterWorktreeHandler = withMcpGuard(
  'enter_worktree',
  async (
    args: EnterWorktreeArgs,
    ctx: HandlerContext,
    handlerDeps?: EnterWorktreeHandlerDeps,
  ) => {
    const mergedDeps: EnterWorktreeDeps = {
      ...DEFAULT_SESSION_DEPS,
      ...handlerDeps?.implDeps,
    };
    const callerSessionId = ctx.caller.callerSessionId;
    const existing = worktreeTransitionRepo.get(callerSessionId);
    if (existing && existing.phase !== 'cleared') {
      if (
        existing.direction === 'enter' &&
        (existing.phase === 'creating' ||
          existing.phase === 'enter_waiting_tool_result')
      ) {
        return structuredOk({
          transitionId: worktreeTransitionId(existing),
          direction: 'enter',
          state: 'waiting-tool-result',
          effectiveFrom: 'automatic-next-turn',
          worktreePath: existing.worktreePath,
          startCommit: existing.baseCommit,
          headMode: existing.workBranch
            ? 'legacy-attached'
            : 'detached',
          markerSet: existing.phase !== 'creating',
        } satisfies EnterWorktreeResult);
      }
      return err(
        `session already owns worktree transition ${worktreeTransitionId(
          existing,
        )} in phase ${existing.phase}`,
        existing.phase === 'active'
          ? 'Nested enter_worktree is not allowed. Finish and call exit_worktree first.'
          : 'Retry after the current automatic cwd transition settles.',
      );
    }

    let toolUseId: string;
    try {
      toolUseId = worktreeTransitionCoordinator.reserveToolInvocation(
        callerSessionId,
        'enter',
      );
    } catch (error) {
      return err(
        error instanceof Error ? error.message : String(error),
        'The tool must be invoked from the active in-app provider turn so Agent Deck can correlate its exact tool result.',
      );
    }
    const prepared = await prepareEnterWorktree(
      {
        callerSessionId,
        startPoint: args.startPoint,
        worktreePathOverride: args.worktreePath,
        worktreeRootOverride: args.worktreeRoot,
      },
      mergedDeps,
    );
    if (_internalIsError(prepared)) {
      worktreeTransitionCoordinator.releaseToolInvocation(
        callerSessionId,
        toolUseId,
      );
      return err(prepared.error, prepared.hint);
    }

    let transition;
    try {
      transition = worktreeTransitionRepo.createEnter({
        sessionId: callerSessionId,
        originalCwd: prepared.originalCwd,
        targetCwd: prepared.worktreePath,
        mainRepo: prepared.mainRepo,
        worktreePath: prepared.worktreePath,
        baseCommit: prepared.startCommit,
        toolUseId,
        continuationKey: `worktree-cwd:${randomUUID()}`,
        requestedAt: Date.now(),
      });
      worktreeTransitionCoordinator.bindToolInvocation(
        callerSessionId,
        toolUseId,
        transition.generation,
      );
    } catch (error) {
      worktreeTransitionCoordinator.releaseToolInvocation(
        callerSessionId,
        toolUseId,
      );
      const hint =
        error instanceof WorktreeTransitionConflictError
          ? 'Retry after the existing transition settles.'
          : 'No git worktree was created.';
      return err(error instanceof Error ? error.message : String(error), hint);
    }

    try {
      await createPreparedWorktree(prepared, mergedDeps);
      transition = worktreeTransitionRepo.markEnterCreated(
        callerSessionId,
        transition.generation,
        Date.now(),
      );
      worktreeTransitionCoordinator.arm(transition);
    } catch (error) {
      const warnings = await rollbackPreparedWorktree(
        prepared,
        mergedDeps,
      );
      if (warnings.length === 0) {
        try {
          const current = worktreeTransitionRepo.get(callerSessionId);
          if (
            current &&
            current.generation === transition.generation &&
            (current.phase === 'creating' ||
              current.phase === 'enter_waiting_tool_result')
          ) {
            await worktreeTransitionCoordinator.releaseAbortedPreparation(
              current,
            );
            transition = worktreeTransitionRepo.compareAndSetPhase({
              sessionId: callerSessionId,
              generation: transition.generation,
              expected: current.phase,
              next: 'cleared',
              updatedAt: Date.now(),
              lastError: error instanceof Error ? error.message : String(error),
            });
          }
        } catch {
          // The primary error and explicit rollback warning below remain authoritative.
        }
      } else {
        worktreeTransitionRepo.setLastError(
          callerSessionId,
          transition.generation,
          `${error instanceof Error ? error.message : String(error)}; rollback: ${warnings.join(
            '; ',
          )}`,
          Date.now(),
        );
      }
      return err(
        `enter_worktree preparation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        warnings.length
          ? `Rollback was incomplete and the transition lease was retained: ${warnings.join(
              '; ',
            )}`
          : 'The created detached worktree was removed without changing any Git ref; retry from the active turn.',
      );
    }

    return structuredOk({
      transitionId: worktreeTransitionId(transition),
      direction: 'enter',
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
      worktreePath: transition.worktreePath,
      startCommit: transition.baseCommit,
      headMode: 'detached',
      markerSet: true,
    } satisfies EnterWorktreeResult);
  },
);
