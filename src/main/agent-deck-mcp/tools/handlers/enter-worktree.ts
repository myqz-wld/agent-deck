/**
 * enter_worktree handler 入口（plan codex-handoff-team-alignment-20260518 P1 Step 1.3 /
 * D2 + 不变量 5）。
 *
 * 薄 wrapper：deny external caller + validateExternalCaller + 注入 sessionRepo seam(callerCwd /
 * setCwdReleaseMarker)+ 调 enterWorktreeImpl + 包 ok/err。业务行为完全在 enter-worktree-impl.ts
 * （git/fs/frontmatter 操作 + DEFAULT_DEPS inject 模式）;impl 不 import sessionRepo 避免触发
 * electron.app load(让 impl test 走 deps inject 时不撞 electron)。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.enter_worktree = false）：
 * 写 git + setCwdReleaseMarker 是 per-session 状态写,需要真实 callerSessionId;external
 * stdio client 没真 caller sid 无法 setMarker → 直接 deny。
 *
 * 用途:让 codex / 跨 adapter caller 调 enter_worktree 进 worktree 时,handler setMarker 让
 * archive_plan 预检 4 态分流认得跨 adapter 路径(详 P1 Step 1.4 archive-plan-impl.ts)。
 * claude builtin EnterWorktree 已对 claude SDK session 走 ExitWorktree → cwd 移出 worktree 的
 * 现有路径不动(claude 端 builtin 仍是首选,本 mcp tool 是补充给 codex / 跨 adapter)。
 */

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
    // 默认 sessionRepo seam 合并 caller 显式 implDeps(caller 显式字段优先,DEFAULT_SESSION_DEPS 仅
    // 填缺位 — 与 archive-plan.ts mergeCallerCwd 同款思路)。
    const mergedDeps: EnterWorktreeDeps = {
      ...DEFAULT_SESSION_DEPS,
      ...handlerDeps?.implDeps,
    };
    const result = await enterWorktreeImpl(
      {
        planId: args.planId,
        callerSessionId: ctx.caller.callerSessionId,
        worktreePathOverride: args.worktreePath,
        baseCommitOverride: args.baseCommit,
        baseBranchOverride: args.baseBranch,
        planFilePathOverride: args.planFilePath,
      },
      mergedDeps,
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
