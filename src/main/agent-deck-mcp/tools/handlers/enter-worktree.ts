import { sessionRepo } from '@main/store/session-repo';
import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { EnterWorktreeArgs, EnterWorktreeResult } from '../schemas';
import {
  enterWorktreeImpl,
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
 * 与 archive-plan-impl 同款 — sessionRepo 在 handler 层 import 触发 electron load OK,但 impl
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
    const result = await enterWorktreeImpl(
      {
        callerSessionId: ctx.caller.callerSessionId,
        baseBranch: args.baseBranch,
        workBranchOverride: args.workBranch,
        worktreePathOverride: args.worktreePath,
        worktreeRootOverride: args.worktreeRoot,
      },
      mergedDeps,
    );

    if (_internalIsError(result)) {
      return err(result.error, result.hint);
    }

    return ok({
      worktreePath: result.worktreePath,
      workBranch: result.workBranch,
      baseBranch: result.baseBranch,
      baseCommit: result.baseCommit,
      baseSource: result.baseSource,
      markerSet: result.markerSet,
    } satisfies EnterWorktreeResult);
  },
);
