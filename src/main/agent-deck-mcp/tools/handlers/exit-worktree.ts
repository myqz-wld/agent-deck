import { randomUUID } from 'node:crypto';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { worktreeTransitionCoordinator } from '@main/session/worktree-transition/coordinator';
import {
  cleanupStructuredWorktree,
  preflightStructuredWorktreeExit,
} from '@main/session/worktree-transition/git-cleanup';
import { worktreeTransitionId } from '@main/session/worktree-transition/types';
import {
  err,
  structuredOk,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ExitWorktreeArgs, ExitWorktreeResult } from '../schemas';
import {
  exitWorktreeImpl,
  _internalIsError,
  type ExitWorktreeDeps,
} from './exit-worktree-impl';

/**
 * 测试 inject seam:test 通过 depsOverride.implDeps 注入 mock git/fs/sessionRepo 走纯 in-memory。
 * 默认 handler 自己注入 sessionRepo 的真实 callerMarker / clearCwdReleaseMarker 调用,impl 其他
 * fs/git deps fallback impl 的 DEFAULT_DEPS(真 execFile / fs)。
 */
export interface ExitWorktreeHandlerDeps {
  implDeps?: ExitWorktreeDeps;
}

/**
 * 默认 sessionRepo seam:callerMarker 反查 sessionRepo.get(sid).cwdReleaseMarker;
 * clearCwdReleaseMarker 写 DB null。与 archive-plan / enter-worktree handler 同款 —
 * sessionRepo 在 handler 层 import 触发 electron load OK,但 impl 不能 import。
 */
const DEFAULT_SESSION_DEPS: Required<Pick<ExitWorktreeDeps, 'callerMarker' | 'clearCwdReleaseMarker'>> = {
  callerMarker: (sid) => sessionRepo.get(sid)?.cwdReleaseMarker ?? null,
  clearCwdReleaseMarker: (sid) => sessionRepo.clearCwdReleaseMarker(sid),
};

export const exitWorktreeHandler = withMcpGuard(
  'exit_worktree',
  async (
    args: ExitWorktreeArgs,
    ctx: HandlerContext,
    handlerDeps?: ExitWorktreeHandlerDeps,
  ) => {
    const mergedDeps: ExitWorktreeDeps = {
      ...DEFAULT_SESSION_DEPS,
      ...handlerDeps?.implDeps,
    };
    const callerSessionId = ctx.caller.callerSessionId;
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
          workBranch: transition.workBranch,
        } satisfies ExitWorktreeResult);
      }
      if (transition.phase === 'cleanup_pending') {
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
            workBranch: cleared.workBranch,
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
        worktreeTransitionCoordinator.releaseToolInvocation(
          callerSessionId,
          toolUseId,
        );
        const current = worktreeTransitionRepo.get(callerSessionId);
        if (
          current &&
          current.generation === transition.generation &&
          current.phase === 'exit_preflight'
        ) {
          try {
            await worktreeTransitionCoordinator.releaseAbortedPreparation(
              current,
            );
            worktreeTransitionRepo.compareAndSetPhase({
              sessionId: callerSessionId,
              generation: current.generation,
              expected: 'exit_preflight',
              next: 'active',
              updatedAt: Date.now(),
              lastError:
                error instanceof Error ? error.message : String(error),
            });
          } catch {
            // The primary structured failure below remains authoritative.
          }
        }
        return err(
          `exit_worktree could not arm the automatic cwd transition: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'The worktree was not removed. Retry from the active provider turn.',
          { markerCleared: false },
        );
      }

      return structuredOk({
        transitionId: worktreeTransitionId(exiting),
        direction: 'exit',
        state: 'waiting-tool-result',
        effectiveFrom: 'automatic-next-turn',
        worktreePath: exiting.worktreePath,
        workBranch: exiting.workBranch,
      } satisfies ExitWorktreeResult);
    }

    const result = await exitWorktreeImpl(
      {
        callerSessionId,
        worktreePathOverride: args.worktreePath,
        discardChanges: args.discardChanges,
        deleteBranch: args.deleteBranch,
      },
      mergedDeps,
    );

    if (_internalIsError(result)) {
      // R3 fix-5 (M5 codex Batch B MED-2): partial-success error path 透传 markerCleared 字段
      // 给 MCP caller。result.markerCleared 在 exit-worktree-impl ExitWorktreeError 类型可能
      // undefined（无 marker 场景）或 boolean（partial-success 如 step 5d branch 失败时 step 5c
      // 已 clear marker / step 4 .git 损坏 action=keep cleanup 已 clear marker）。caller 据此
      // 决定 retry hint（marker 已清 → 不需手动 clearCwdReleaseMarker；marker 未清 → 提示 caller
      // 走 IPC sessionRepo.clearCwdReleaseMarker 兜底）。
      const extras =
        result.markerCleared !== undefined
          ? { markerCleared: result.markerCleared }
          : undefined;
      return err(result.error, result.hint, extras);
    }

    return structuredOk({
      transitionId: null,
      direction: 'exit',
      state: 'completed-legacy',
      effectiveFrom: 'already-effective',
      worktreePath: result.worktreePath,
      workBranch: result.workBranch,
      branchDeleted: result.branchDeleted,
      worktreeRemoved: result.worktreeRemoved,
      markerCleared: result.markerCleared,
    } satisfies ExitWorktreeResult);
  },
);
