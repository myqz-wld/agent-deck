/**
 * archive_plan handler 入口（plan mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.2;
 * CHANGELOG_99 加 default 归档 caller,与 K2 baton CHANGELOG_97 同款语义)。
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
 *
 * **CHANGELOG_99 default 归档 caller(与 K2 baton 同款语义)**：plan 收口 = 这条 plan-driven
 * 会话使命终结(代码已合并 / worktree 已删 / cwd 已失效)。caller session 留 active 没意义,
 * 用户继续点开发消息会撞「Path does not exist」弯绕错误链。归档 = 用户在 SessionList 看到
 * 它移到「已归档」列表,自然不会主动给它发消息;即便取消归档发消息,recoverer cwd 启发式
 * fallback (CHANGELOG_99 Phase C)兜底给清晰错误。
 *
 * archive 行为复制 K2 hand-off-session.ts L194-216 模式:
 * - 反查 callerSessionRow 探针 (try/catch DB 不可用 fail-safe)
 * - external sentinel → 'skipped' (按 deny external 拦截不到这里;防御性双保险)
 * - row missing → 'failed' + console.warn 不阻塞 ok return
 * - archive 抛错 → 'failed' + console.warn 不阻塞
 * - 成功 → 'ok'
 * - ok return 加 `archived: 'ok' | 'failed' | 'skipped'` 字段
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
import { sessionManager } from '@main/session/manager';
import {
  archivePlanImpl,
  _isArchivePlanError,
  type ArchivePlanDeps,
} from './archive-plan-impl';

/**
 * 测试 inject seam：test 通过 depsOverride.implDeps 注入 mock fs/git 走纯 in-memory。
 * 默认走 archive-plan-impl.ts 的 DEFAULT_DEPS（真 fs / git）。
 *
 * CHANGELOG_99：archiveSession seam(与 K2 hand-off-session 同款),让单测无需 mock 整个
 * sessionManager 即可验证 archive caller 行为。
 */
export interface ArchivePlanHandlerDeps {
  implDeps?: ArchivePlanDeps;
  /** CHANGELOG_99：archive caller 的 test seam(与 K2 hand-off-session.ts 同款) */
  archiveSession?: (sessionId: string) => Promise<void>;
}

/** 与 hand-off-session.ts 同款：从 caller session id 反查 cwd 构造 implDeps 子集。 */
function resolveCallerCwdDeps(callerSessionId: string): ArchivePlanDeps {
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) return {};
  // CHANGELOG_99 R1 fix MED-1:sessionRepo.get 包 try/catch fail-safe (与 archive 段 try/catch
  // 对称)。DB 异常 (test 未 init / 生产 SQLite locked / FK conflict) 时返回空 deps,让 impl
  // 退化到 DEFAULT_DEPS.cwd = process.cwd() 兜底,而非 handler 直接 crash。
  let row: ReturnType<typeof sessionRepo.get> = null;
  try {
    row = sessionRepo.get(callerSessionId);
  } catch {
    return {};
  }
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

  // caller cwd 注入（H5 修复）：详 mergeCallerCwd / hand-off-session 同款实现
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

  // CHANGELOG_99：default 归档 caller(与 K2 baton 同款)。impl 已成功(git ff merge / mv plan
  // / commit / git worktree remove 全跑完),caller 的 cwd 已失效 → 归档让用户在 SessionList
  // 直接看到这条会话已归档,避免后续发消息撞 cwd 弯绕。
  // archive 行为镜像 K2 hand-off-session.ts L194-216:
  // - external sentinel → 'skipped' (deny external 拦下不会到这,双保险)
  // - 反查 callerSessionRow try/catch DB 不可用 → 'failed' + console.warn 不阻塞
  // - row missing → 'failed' + console.warn 不阻塞
  // - archive 抛错 → 'failed' + console.warn 不阻塞
  // - 成功 → 'ok'
  let archived: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL) {
    let callerSessionRow: ReturnType<typeof sessionRepo.get> = null;
    try {
      callerSessionRow = sessionRepo.get(caller.callerSessionId);
    } catch {
      // DB 不可用(typical: test 环境 DB 未 init)→ 留 null,按 row missing 路径 'failed'
      callerSessionRow = null;
    }
    if (!callerSessionRow) {
      archived = 'failed';
      console.warn(
        `[mcp archive_plan] cannot archive caller ${caller.callerSessionId}: not in sessions table (异常被清理 / 边界状态)`,
      );
    } else {
      const archiveFn =
        handlerDeps?.archiveSession ?? ((sid: string) => sessionManager.archive(sid));
      try {
        await archiveFn(caller.callerSessionId);
        archived = 'ok';
      } catch (e) {
        archived = 'failed';
        console.warn(
          `[mcp archive_plan] archive caller ${caller.callerSessionId} failed:`,
          e,
        );
      }
    }
  }

  return ok({
    archived_path: result.archivedPath,
    commit_hash: result.commitHash,
    branch_deleted: result.branchDeleted,
    worktree_removed: result.worktreeRemoved,
    plans_index_appended: result.plansIndexAppended,
    final_status: result.finalStatus,
    /**
     * CHANGELOG_99：'ok' = caller 归档成功 / 'failed' = warn-only 不阻塞(callerRow 缺 / DB
     * 不可用 / archive 抛错) / 'skipped' = external caller(理论上 deny external 拦截不到这里)
     */
    archived,
  });
}
