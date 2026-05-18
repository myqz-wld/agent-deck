/**
 * exit_worktree handler 入口（plan codex-handoff-team-alignment-20260518 P1 Step 1.3 /
 * D2 + 不变量 5）。
 *
 * 薄 wrapper：deny external caller + validateExternalCaller + 调 exitWorktreeImpl + 包 ok/err。
 * 业务行为完全在 exit-worktree-impl.ts（git/fs/DB 操作 + DEFAULT_DEPS inject 模式），
 * 单测在那里 cover；本 handler 只验证 deny external + caller 反查行为（与其他 handler 一致）。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.exit_worktree = false）：
 * 写 git + clearCwdReleaseMarker 是 per-session 状态写,需要真实 caller_session_id;external
 * stdio client 没真 caller sid 无法 clearMarker → 直接 deny。
 *
 * 用途:配合 enter_worktree 给 codex / 跨 adapter caller 提供 claude builtin ExitWorktree 的
 * 等价能力。两种 action:
 * - 'keep': 中途 hand-off 切会话场景,worktree 改动保留,marker 清(防 caller 后续误判仍持有)
 * - 'remove': plan 完成/中止收口场景,worktree + branch 整片删,marker 清
 */

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
 * 默认走 exit-worktree-impl.ts 的 DEFAULT_DEPS(真 git / fs / sessionRepo)。
 */
export interface ExitWorktreeHandlerDeps {
  implDeps?: ExitWorktreeDeps;
}

export const exitWorktreeHandler = withMcpGuard(
  'exit_worktree',
  async (
    args: ExitWorktreeArgs,
    ctx: HandlerContext,
    handlerDeps?: ExitWorktreeHandlerDeps,
  ) => {
    const result = await exitWorktreeImpl(
      {
        callerSessionId: ctx.caller.callerSessionId,
        action: args.action,
        worktreePathOverride: args.worktree_path,
        discardChanges: args.discard_changes,
      },
      handlerDeps?.implDeps,
    );

    if (_internalIsError(result)) {
      return err(result.error, result.hint);
    }

    return ok({
      worktreePath: result.worktreePath,
      action: result.action,
      branchDeleted: result.branchDeleted,
      worktreeRemoved: result.worktreeRemoved,
      markerCleared: result.markerCleared,
    } satisfies ExitWorktreeResult);
  },
);
