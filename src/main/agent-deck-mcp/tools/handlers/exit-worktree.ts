import { sessionRepo } from '@main/store/session-repo';
import {
  err,
  ok,
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
    const result = await exitWorktreeImpl(
      {
        callerSessionId: ctx.caller.callerSessionId,
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

    return ok({
      worktreePath: result.worktreePath,
      workBranch: result.workBranch,
      branchDeleted: result.branchDeleted,
      worktreeRemoved: result.worktreeRemoved,
      markerCleared: result.markerCleared,
    } satisfies ExitWorktreeResult);
  },
);
