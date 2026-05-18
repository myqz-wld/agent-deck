/**
 * archive_plan handler 入口（plan mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.2;
 * CHANGELOG_99 加 default 归档 caller,与 K2 baton CHANGELOG_97 同款语义;
 * CHANGELOG_109 R37 P2-M Step 3.5 抽 baton-cleanup.ts 共享 ~80 行模板）。
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
 * **CHANGELOG_99 default 归档 caller + CHANGELOG_106 teammate shutdown(baton 同款语义)**：
 * 两段统一收口到 baton-cleanup.ts 的 runBatonCleanup helper(R37 P2-M Step 3.5)。本 handler
 * 只在 impl 成功后调一次 helper,把 teammate shutdown + archive caller 两个三态结果透传到
 * ok return,不再独立维护 ~80 行模板代码。详 baton-cleanup.ts 顶部 jsdoc。
 */

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ArchivePlanArgs, ArchivePlanResult } from '../schemas';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import { sessionRepo } from '@main/store/session-repo';
import {
  archivePlanImpl,
  _isArchivePlanError,
  type ArchivePlanDeps,
} from './archive-plan-impl';
import { runBatonCleanup } from './baton-cleanup';
import type { ShutdownTeammatesResult } from './shutdown-teammates-on-baton';

/**
 * 测试 inject seam：test 通过 depsOverride.implDeps 注入 mock fs/git 走纯 in-memory。
 * 默认走 archive-plan-impl.ts 的 DEFAULT_DEPS（真 fs / git）。
 *
 * CHANGELOG_99：archiveSession seam(与 K2 hand-off-session 同款),让单测无需 mock 整个
 * sessionManager 即可验证 archive caller 行为。
 *
 * CHANGELOG_106：shutdownTeammates seam,让单测无需 mock 整个 shutdownTeammatesOnBaton 内部
 * 的 sessionManager.close / agentDeckTeamRepo 调用即可验证 handler 集成行为。default 走真
 * helper(它内部走真 sessionManager.close + agentDeckTeamRepo)。
 *
 * CHANGELOG_109(R37 P2-M Step 3.5)：handler 端 seam shape 不变(向后兼容),内部把这两个
 * seam 透传给 runBatonCleanup deps,让现有 archive-plan.handler.test.ts 5 case 0 改造跑过。
 */
export interface ArchivePlanHandlerDeps {
  implDeps?: ArchivePlanDeps;
  /** CHANGELOG_99：archive caller 的 test seam(与 K2 hand-off-session 同款) */
  archiveSession?: (sessionId: string) => Promise<void>;
  /** CHANGELOG_106：teammate shutdown helper 的 test seam（mock 整个 helper 调用） */
  shutdownTeammates?: (callerSessionId: string) => Promise<ShutdownTeammatesResult>;
}

/**
 * 与 hand-off-session.ts 同款：从 caller session id 反查 cwd + cwdReleaseMarker 构造 implDeps 子集。
 *
 * plan codex-handoff-team-alignment-20260518 P1 Step 1.4 扩展：除注入 cwd 外，同时注入
 * cwdReleaseMarker fetcher 让 impl 走 4 态分流（详 archive-plan-impl §step 4）。两个字段都
 * 从同一个 sessionRepo.get(callerSid) row 派生（一次 DB read 复用，避免 N+1）。
 */
function resolveCallerCwdDeps(callerSessionId: string): ArchivePlanDeps {
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) return {};
  // CHANGELOG_99 R1 fix MED-1:sessionRepo.get 包 try/catch fail-safe (与 archive 段 try/catch
  // 对称)。DB 异常 (test 未 init / 生产 SQLite locked / FK conflict) 时返回空 deps,让 impl
  // 退化到 DEFAULT_DEPS.cwd = process.cwd() + cwdReleaseMarker = () => null 兜底,而非 handler
  // 直接 crash。
  // P5 Round 1 reviewer-codex HIGH-2 (downgraded MED) 修法:DB 异常时 console.warn 让 operator
  // 看到 fail-open 退化(原静默 return {} 看不到 DB 问题)。fail-open 设计取舍保留(handler 稳定
  // > 严格安全),archive git 操作走 mainRepo 不依赖 callerCwd 限定 blast radius。
  let row: ReturnType<typeof sessionRepo.get> = null;
  try {
    row = sessionRepo.get(callerSessionId);
  } catch (err) {
    console.warn(
      `[archive-plan] sessionRepo.get(${callerSessionId}) threw — falling back to DEFAULT_DEPS (cwd=process.cwd, marker=null). Archive proceeds via mainRepo git ops; cwd precheck degrades to "no marker" branch.`,
      err,
    );
    return {};
  }
  if (!row) return {};
  // P5 Round 1 reviewer-claude LOW-5 修法 (cwd / marker 独立 fallback):
  // 旧实现 `if (!row?.cwd) return {};` 一刀切丢弃 marker,即使 row.cwdReleaseMarker 有值也整体退化
  // 到 DEFAULT_DEPS。改为各自独立条件 — cwd null 仍 inject marker 让 impl 4 态认得 cwd invalid
  // 状态(plan §不变量 5 (b)/(d) 走 cwd-invalid 分支)。
  // sessions 表 cwd 列 NOT NULL DEFAULT '' (v001 init schema),实际 row.cwd 通常 truthy;但
  // 健壮起见两字段各自独立处理。
  const cwd = row.cwd || null;
  // plan codex-handoff-team-alignment-20260518 P1 Step 1.4：marker 同 cwd 一次 row read 注入,
  // 让 impl 4 态分流认得跨 adapter 路径(状态 2 放过)。marker 为 null 时 impl 走「无 marker」
  // 分支(状态 3 reject if inWorktree)。
  const marker = row.cwdReleaseMarker ?? null;
  // P5 Round 1 reviewer-codex HIGH-1 修法 (release marker seam):
  // archive 成功后 impl 调本 thunk 清 sessionRepo.cwd_release_marker 字段(与 markClosed/close
  // hook 同款,但本 release seam 在 archive 路径独立 — archive_caller=false 时 caller session
  // 仍 active 也必须清 stale marker 避免下次 archive 撞 4 态状态 4 误 reject)。
  // sessionRepo.clearCwdReleaseMarker 是 sync,包成 async thunk 与 impl signature 对齐。
  const clearMarker = async (): Promise<void> => {
    sessionRepo.clearCwdReleaseMarker(callerSessionId);
  };
  const deps: ArchivePlanDeps = {
    cwdReleaseMarker: () => marker,
    clearCwdReleaseMarker: clearMarker,
  };
  if (cwd) {
    deps.cwd = () => cwd;
  }
  return deps;
}

/**
 * 合并 caller 显式 implDeps 与 sessionRepo 反查的 callerCwd + cwdReleaseMarker 注入。
 * 优先级（高→低）：caller 显式 implDeps.cwd / cwdReleaseMarker > sessionRepo 反查 > impl DEFAULT_DEPS。
 *
 * plan codex-handoff-team-alignment-20260518 P1 Step 1.4：merge 同时处理 cwd 和 cwdReleaseMarker
 * 两个字段独立优先级 — caller 可只覆盖其中一个（如 unit test mock cwd 不 mock marker → marker
 * 从 sessionRepo 反查；mock marker 不 mock cwd → cwd 从 sessionRepo 反查），互不耦合。
 */
function mergeCallerCwd(
  callerImplDeps: ArchivePlanDeps | undefined,
  callerSessionId: string,
): ArchivePlanDeps | undefined {
  // 如 caller 同时显式传 cwd + cwdReleaseMarker → 直接用，不再反查
  if (callerImplDeps?.cwd && callerImplDeps?.cwdReleaseMarker) return callerImplDeps;
  const sessionInjection = resolveCallerCwdDeps(callerSessionId);
  if (!sessionInjection.cwd && !sessionInjection.cwdReleaseMarker) return callerImplDeps;
  // caller 显式字段优先（cwd / cwdReleaseMarker 各自独立），sessionRepo 反查仅填缺位
  return {
    ...sessionInjection,
    ...callerImplDeps,
  };
}

export const archivePlanHandler = withMcpGuard(
  'archive_plan',
  async (
    args: ArchivePlanArgs,
    ctx: HandlerContext,
    handlerDeps?: ArchivePlanHandlerDeps,
  ) => {
    const { caller } = ctx;

    // caller cwd 注入（H5 修复）：详 mergeCallerCwd / hand-off-session 同款实现
    const mergedImplDeps = mergeCallerCwd(handlerDeps?.implDeps, caller.callerSessionId);

    const result = await archivePlanImpl(
      {
        planId: args.plan_id,
        worktreePath: args.worktree_path,
        baseBranch: args.base_branch,
        planFilePathOverride: args.plan_file_path,
        changelogId: args.changelog_id,
      },
      mergedImplDeps,
    );

    if (_isArchivePlanError(result)) {
      return err(result.error, result.hint);
    }

    // CHANGELOG_109(R37 P2-M Step 3.5)：baton cleanup 两段(teammate shutdown + archive caller)
    // 收口到 runBatonCleanup helper(详 baton-cleanup.ts 顶部 jsdoc)。helper 内部串行跑 phase 1
    // → phase 2,失败容错全在 helper 里(单个 close warn / helper 抛错兜底 / archive 失败 warn);
    // handler 这层只透传 input + 把两个三态结果 spread 进 ok return。
    //
    // 时序保证(必须 phase 1 → phase 2):由 helper 内部 await 串行保证;handler 不能颠倒调用顺序。
    //
    // archive_plan 不传 excludeSessionIds(plan 收口前不 spawn 新 session);keep_teammates 从
    // args 直接读 boolean(不传 / undefined → false → 走真 helper 关 teammate)。
    const cleanup = await runBatonCleanup(
      {
        callerSessionId: caller.callerSessionId,
        keepTeammates: args.keep_teammates === true,
        toolName: 'archive_plan',
      },
      {
        shutdownTeammates: handlerDeps?.shutdownTeammates,
        archiveSession: handlerDeps?.archiveSession,
      },
    );

    return ok({
      archived_path: result.archivedPath,
      commit_hash: result.commitHash,
      branch_deleted: result.branchDeleted,
      worktree_removed: result.worktreeRemoved,
      plans_index_action: result.plansIndexAction,
      final_status: result.finalStatus,
      warnings: result.warnings,
      /**
       * CHANGELOG_99：'ok' = caller 归档成功 / 'failed' = warn-only 不阻塞(callerRow 缺 / DB
       * 不可用 / archive 抛错) / 'skipped' = external caller(理论上 deny external 拦截不到这里)
       */
      archived: cleanup.archived,
      /**
       * CHANGELOG_106：teammate shutdown 详情 — { closed: string[], failed: Array<{sessionId,reason}>,
       * skipped: 'caller-not-lead' | 'keep-teammates' | null }。
       * - closed: 成功 close 的 teammate sid 列表(已 dedup 跨 team 共享同 sid)
       * - failed: close 失败的 teammate(含 reason),warn 不阻塞 ok return
       * - skipped: 'keep-teammates'(caller 显式传) / 'caller-not-lead'(caller 不是 lead) /
       *   null(正常处理含 closed=[] 的 caller=lead 但 team 内无其他 teammate)
       */
      teammatesShutdown: cleanup.teammatesShutdown,
    } satisfies ArchivePlanResult);
  },
);
