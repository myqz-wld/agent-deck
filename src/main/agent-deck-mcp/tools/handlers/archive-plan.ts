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
import { archivePlanImpl, _isArchivePlanError } from './archive-plan-impl';

export async function archivePlanHandler(
  args: ArchivePlanArgs,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('archive_plan', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  const result = await archivePlanImpl({
    planId: args.plan_id,
    worktreePath: args.worktree_path,
    baseBranch: args.base_branch,
    planFilePathOverride: args.plan_file_path,
  });

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
