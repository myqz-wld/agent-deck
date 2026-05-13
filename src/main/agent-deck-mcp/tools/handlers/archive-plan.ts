/**
 * archive_plan handler 入口（plan mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.2）。
 *
 * 薄 wrapper：deny external caller + validateExternalCaller + 调 archivePlanImpl + 包 ok/err。
 * 业务行为完全在 archive-plan-impl.ts（git/fs/frontmatter 操作 + DEFAULT_DEPS inject 模式），
 * 单测在那里 cover；本 handler 只验证 deny external + caller 反查行为（与其他 handler 一致）。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.archive_plan = false）：
 * 写 git + 删 worktree 高风险，绝不允许 stdio external client 调用（避免被恶意 mcp client
 * 利用清理 worktree / 在 main repo 下 commit）。
 *
 * **Caller cwd 注入（plan mcp-handoff-fix-and-skill-timer-20260514 Phase A1）**：
 * impl DEFAULT_DEPS.cwd = process.cwd() 是 Electron main 进程 cwd（通常 `/`），与
 * caller SDK session 的真实 cwd 无关。impl 用此 cwd 做「caller 是否在 worktree 内」预检
 * （ExitWorktree 强制要求）→ 不修就永远判定 caller 不在 worktree 内 → 该预检完全失效。
 * 修法：handler 从 sessionRepo 反查 caller cwd 注入到 implDeps。external sentinel 时
 * 跳过注入（impl 仍走 DEFAULT_DEPS.cwd 兜底；按 deny external 规则其实到不了这里）。
 */

import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { ArchivePlanArgs } from '../schemas';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import { sessionRepo } from '@main/store/session-repo';
import {
  archivePlanImpl,
  _isArchivePlanError,
  type ArchivePlanDeps,
} from './archive-plan-impl';

/**
 * 测试 inject seam：test 通过 depsOverride.implDeps 注入 mock fs/git 走纯 in-memory。
 * 默认走 archive-plan-impl.ts 的 DEFAULT_DEPS（真 fs / git）。
 */
export interface ArchivePlanHandlerDeps {
  implDeps?: ArchivePlanDeps;
}

/** 与 start-next-session.ts 同款：从 caller session id 反查 cwd 构造 implDeps 子集。 */
function resolveCallerCwdDeps(callerSessionId: string): ArchivePlanDeps {
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) return {};
  const row = sessionRepo.get(callerSessionId);
  if (!row?.cwd) return {};
  const cwd = row.cwd;
  return { cwd: () => cwd };
}

/**
 * 合并 caller 显式 implDeps 与 sessionRepo 反查的 callerCwd 注入。
 * 优先级（高→低）：caller 显式 implDeps.cwd > sessionRepo 反查 > impl DEFAULT_DEPS。
 */
function mergeCallerCwd(
  callerImplDeps: ArchivePlanDeps | undefined,
  callerSessionId: string,
): ArchivePlanDeps | undefined {
  if (callerImplDeps?.cwd) return callerImplDeps;
  const callerCwdInjection = resolveCallerCwdDeps(callerSessionId);
  if (!callerCwdInjection.cwd) return callerImplDeps;
  return { ...callerImplDeps, ...callerCwdInjection };
}

export async function archivePlanHandler(
  args: ArchivePlanArgs,
  ctx: HandlerContext,
  handlerDeps?: ArchivePlanHandlerDeps,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('archive_plan', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  // caller cwd 注入（H5 修复）：详 mergeCallerCwd / start-next-session 同款实现
  const mergedImplDeps = mergeCallerCwd(handlerDeps?.implDeps, caller.callerSessionId);

  const result = await archivePlanImpl(
    {
      planId: args.plan_id,
      worktreePath: args.worktree_path,
      baseBranch: args.base_branch,
      planFilePathOverride: args.plan_file_path,
    },
    mergedImplDeps,
  );

  if (_isArchivePlanError(result)) {
    return err(result.error, result.hint);
  }

  return ok({
    archived_path: result.archivedPath,
    commit_hash: result.commitHash,
    branch_deleted: result.branchDeleted,
    worktree_removed: result.worktreeRemoved,
    plans_index_appended: result.plansIndexAppended,
    final_status: result.finalStatus,
  });
}
