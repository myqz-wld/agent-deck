/**
 * exit_worktree handler 入口（plan codex-handoff-team-alignment-20260518 P1 Step 1.3 /
 * D2 + 不变量 5）。
 *
 * 薄 wrapper：deny external caller + validateExternalCaller + 注入 sessionRepo seam(callerMarker /
 * clearCwdReleaseMarker)+ 调 exitWorktreeImpl + 包 ok/err。业务行为完全在 exit-worktree-impl.ts
 * （git/fs/DB 操作 + DEFAULT_DEPS inject 模式）;impl 不 import sessionRepo 避免触发 electron.app load
 * （让 impl test 走 deps inject 时不撞 electron）。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.exit_worktree = false）：
 * 写 git + clearCwdReleaseMarker 是 per-session 状态写,需要真实 callerSessionId;external
 * stdio client 没真 caller sid 无法 clearMarker → 直接 deny。
 *
 * 用途:配合 enter_worktree 给 codex / 跨 adapter caller 提供 claude builtin ExitWorktree 的
 * 等价能力。两种 action:
 * - 'keep': 中途 hand-off 切会话场景,worktree 改动保留,marker 清(防 caller 后续误判仍持有)
 * - 'remove': plan 完成/中止收口场景,worktree + branch 整片删,marker 清
 */

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
    // 默认 sessionRepo seam 合并 caller 显式 implDeps(caller 显式字段优先 — 与 enter-worktree.ts
    // 同款思路)。
    const mergedDeps: ExitWorktreeDeps = {
      ...DEFAULT_SESSION_DEPS,
      ...handlerDeps?.implDeps,
    };
    const result = await exitWorktreeImpl(
      {
        callerSessionId: ctx.caller.callerSessionId,
        action: args.action,
        worktreePathOverride: args.worktreePath,
        discardChanges: args.discardChanges,
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
      action: result.action,
      branchDeleted: result.branchDeleted,
      worktreeRemoved: result.worktreeRemoved,
      markerCleared: result.markerCleared,
    } satisfies ExitWorktreeResult);
  },
);
