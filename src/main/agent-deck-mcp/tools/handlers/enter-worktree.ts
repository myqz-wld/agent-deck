/**
 * enter_worktree handler 入口（plan codex-handoff-team-alignment-20260518 P1 Step 1.3 /
 * D2 + 不变量 5）。
 *
 * 薄 wrapper：deny external caller + validateExternalCaller + 调 enterWorktreeImpl + 包 ok/err。
 * 业务行为完全在 enter-worktree-impl.ts（git/fs/frontmatter/DB 操作 + DEFAULT_DEPS inject 模式），
 * 单测在那里 cover；本 handler 只验证 deny external + caller 反查行为（与其他 handler 一致）。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.enter_worktree = false）：
 * 写 git + setCwdReleaseMarker 是 per-session 状态写,需要真实 caller_session_id;external
 * stdio client 没真 caller sid 无法 setMarker → 直接 deny。
 *
 * 用途:让 codex / 跨 adapter caller 调 enter_worktree 进 worktree 时,handler setMarker 让
 * archive_plan 预检 4 态分流认得跨 adapter 路径(详 P1 Step 1.4 archive-plan-impl.ts)。
 * claude builtin EnterWorktree 已对 claude SDK session 走 ExitWorktree → cwd 移出 worktree 的
 * 现有路径不动(claude 端 builtin 仍是首选,本 mcp tool 是补充给 codex / 跨 adapter)。
 */

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
 * 默认走 enter-worktree-impl.ts 的 DEFAULT_DEPS(真 git / fs / sessionRepo)。
 */
export interface EnterWorktreeHandlerDeps {
  implDeps?: EnterWorktreeDeps;
}

export const enterWorktreeHandler = withMcpGuard(
  'enter_worktree',
  async (
    args: EnterWorktreeArgs,
    ctx: HandlerContext,
    handlerDeps?: EnterWorktreeHandlerDeps,
  ) => {
    const result = await enterWorktreeImpl(
      {
        planId: args.plan_id,
        callerSessionId: ctx.caller.callerSessionId,
        worktreePathOverride: args.worktree_path,
        baseCommitOverride: args.base_commit,
        baseBranchOverride: args.base_branch,
        planFilePathOverride: args.plan_file_path,
      },
      handlerDeps?.implDeps,
    );

    if (_internalIsError(result)) {
      return err(result.error, result.hint);
    }

    return ok({
      worktreePath: result.worktreePath,
      branchName: result.branchName,
      baseCommit: result.baseCommit,
      baseSource: result.baseSource,
      markerSet: result.markerSet,
    } satisfies EnterWorktreeResult);
  },
);
