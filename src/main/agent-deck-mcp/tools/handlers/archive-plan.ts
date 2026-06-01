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
 *
 * **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.4 / D4 F1d confirm**:
 * 上轮 R3 实证「6 reviewer dormant 未 closed」误归因 lifecycle 过滤问题。lead 现场 grep +
 * reviewer 双方独立 cross-cite 确认真根因 = F2 mainRepo dirty precheck fail-fast → caller 走
 * user CLAUDE.md §Step 4 5 步手工归档绕过 archive_plan tool → 本 handler 没被调到 →
 * runBatonCleanup phase 1 没跑 → reviewer 自然衰减成 dormant 但**没** closed。
 *
 * confirm 现状（grep 可重跑验证 — 阈值 ≥ 1 处命中即 confirm）:
 *   $ grep -n "runBatonCleanup" src/main/agent-deck-mcp/tools/handlers/archive-plan.ts
 *   → import / jsdoc reference / invoke
 *
 * F1d default 行为 = 「caller archive_plan 成功 → runBatonCleanup phase 1 调
 * shutdownTeammatesOnBaton helper → close 同 team active+dormant teammate」**已经是
 * 当前行为**(非本 plan 新加)。本 plan 仅补 F1b 软引导 hint(archive-plan-impl.ts mainRepo
 * dirty precheck 失败时引导 caller fix critical paths 后重 invoke / 必须手工归档场景调 escape
 * hatch shutdown_baton_teammates 补跑)+ F1c shutdown_baton_teammates mcp tool(escape hatch)。
 * changelog 不标 BREAKING(行为不变)。
 *
 * **plan hand-off-session-adopt-teammates-20260520 Phase 3 简化** (D2 + N4): 删除 baton-cleanup
 * teammate-shutdown opt-out 字段。archive_plan 不再支持 phase 1 opt-out — phase 1 永远跑
 * shutdownTeammatesOnBaton(plan 收口语义上不应让 teammate 留下来,plan 完成 = team
 * 整片收口)。
 */

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ArchivePlanArgs, ArchivePlanResult } from '../schemas';
import { sessionRepo } from '@main/store/session-repo';
import {
  archivePlanImpl,
  _isArchivePlanError,
  isPostCommitArchiveError,
  type ArchivePlanDeps,
} from './archive-plan-impl';
import { runBatonCleanup } from './baton-cleanup';
import type { ShutdownTeammatesResult } from './shutdown-teammates-on-baton';
import { fetchCallerSessionRow } from './_shared/caller-cwd-resolver';
import log from '@main/utils/logger';

const logger = log.scope('mcp-archive-plan');

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
 *
 * **Follow-up #7 修法**: row 反查(external sentinel 短路 + try/catch fail-open + warnings 收集)
 * 收口到 _shared/caller-cwd-resolver.ts 的 fetchCallerSessionRow(与 hand-off-session 共用),
 * 本函数只保留 archive 专属的 row→deps 映射(cwd + cwdReleaseMarker + clearCwdReleaseMarker)。
 * shared helper 是纯函数不 logger.warn,故本函数 loop warnings 输出 operator log 保留 P5 R1
 * reviewer-codex HIGH-2 修法的 fail-open 退化可见性(原 throw 路径 operator log;null 路径现也
 * 一并输出 — 严格更多可见性无功能回归)。
 *
 * **REVIEW_56 §F9 修法 (Plan-Review Round 1 + spike3 实证决策 A)**: 签名 `(sid):
 * { deps: ArchivePlanDeps; warnings: string[] }` — fail-open 退化时 warnings 数组收集让 caller
 * (handler) merge 进 ok return.warnings 让 caller (lead / agent) 通过 ok return 看到 fail-open
 * 退化(原 P5 R1 修法只 console.warn 到 operator log,caller silent 不知)。
 */
function resolveCallerCwdDeps(callerSessionId: string): {
  deps: ArchivePlanDeps;
  warnings: string[];
} {
  const { row, warnings } = fetchCallerSessionRow(callerSessionId, 'archive-plan');
  // shared helper 纯收集不 logger.warn → 本函数 loop 输出 operator log 保留 fail-open 退化可见性。
  for (const w of warnings) logger.warn(w);
  if (!row) {
    // external sentinel(warnings=[])/ DB throw / row null(warnings 含退化 msg)→ 退化 DEFAULT_DEPS。
    return { deps: {}, warnings };
  }
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
  // hook 同款,但本 release seam 在 archive 路径独立 — archiveCaller=false 时 caller session
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
  return { deps, warnings };
}

/**
 * 合并 caller 显式 implDeps 与 sessionRepo 反查的 callerCwd + cwdReleaseMarker 注入。
 * 优先级（高→低）：caller 显式 implDeps.cwd / cwdReleaseMarker > sessionRepo 反查 > impl DEFAULT_DEPS。
 *
 * plan codex-handoff-team-alignment-20260518 P1 Step 1.4：merge 同时处理 cwd 和 cwdReleaseMarker
 * 两个字段独立优先级 — caller 可只覆盖其中一个（如 unit test mock cwd 不 mock marker → marker
 * 从 sessionRepo 反查；mock marker 不 mock cwd → cwd 从 sessionRepo 反查），互不耦合。
 *
 * **REVIEW_56 §F9 修法**: 签名同 resolveCallerCwdDeps,返 `{deps, warnings}` 让 handler 把
 * fail-open 退化 warnings 透传到 ok return.warnings。
 */
function mergeCallerCwd(
  callerImplDeps: ArchivePlanDeps | undefined,
  callerSessionId: string,
): { deps: ArchivePlanDeps | undefined; warnings: string[] } {
  // 如 caller 同时显式传 cwd + cwdReleaseMarker → 直接用，不再反查
  if (callerImplDeps?.cwd && callerImplDeps?.cwdReleaseMarker) {
    return { deps: callerImplDeps, warnings: [] };
  }
  const { deps: sessionInjection, warnings } = resolveCallerCwdDeps(callerSessionId);
  if (!sessionInjection.cwd && !sessionInjection.cwdReleaseMarker) {
    return { deps: callerImplDeps, warnings };
  }
  // caller 显式字段优先（cwd / cwdReleaseMarker 各自独立），sessionRepo 反查仅填缺位
  return {
    deps: {
      ...sessionInjection,
      ...callerImplDeps,
    },
    warnings,
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

    // caller cwd 注入（H5 修复）：详 mergeCallerCwd / hand-off-session 同款实现。
    // REVIEW_56 §F9 修法: mergeCallerCwd 返 {deps, warnings} 让 handler 把 fail-open 退化
    // warnings 透传到 ok return.warnings (caller-visible)。
    const { deps: mergedImplDeps, warnings: callerCwdWarnings } = mergeCallerCwd(
      handlerDeps?.implDeps,
      caller.callerSessionId,
    );

    const result = await archivePlanImpl(
      {
        planId: args.planId,
        worktreePath: args.worktreePath,
        baseBranch: args.baseBranch,
        planFilePathOverride: args.planFilePath,
        changelogId: args.changelogId,
      },
      mergedImplDeps,
    );

    if (_isArchivePlanError(result)) {
      // REVIEW_73 MED(deep-review reviewer-claude + reviewer-codex 双方 ✅ + lead grep 验证):
      // post-ff-merge **late phase** 失败(archive commit 已落,仅剩 git artifacts 清理)时
      // 仍跑 baton cleanup。修前 handler 对**任何** ArchivePlanError 一刀切 return err(baton
      // cleanup 在其后),导致 plan 已实质归档(ff-merge + commit + mv plan + INDEX 都成功)但
      // step 14a worktree remove / 14b branch -D 失败 → teammate 不 shutdown 成孤儿 dormant 未
      // closed + caller 不归档。这是本项目反复踩的 dormant 残留的另一条进入路径(正常调 tool
      // 但 late phase 失败,jsdoc 原只归因于手工归档绕过)。
      //
      // **late phase 判定**:error 前缀 `[post-ff-merge:<phase>]`,phase ∈ {archive-rev-parse-HEAD,
      // git-worktree-remove, git-branch-D} 时 archive commit 已落(impl-cleanup.ts:172 git commit
      // 成功之后才进这 3 phase),plan 实质完成 = caller 使命终结 = team 该收口。早期 post-ff-merge
      // phase(write-archived-plan / sync-INDEX / unlink / git-commit 本身失败)plan 尚未完整归档,
      // **不**触发 baton(caller 可能 reset --hard ORIG_HEAD 回滚重试,team 不该被收口)。
      if (isPostCommitArchiveError(result.error)) {
        // plan 已实质归档,跑 baton cleanup 收口 team(teammate shutdown + archive caller),
        // 再透传 impl 的 post-ff-merge error 让 caller 知道 git artifacts 清理还需手工补完。
        try {
          await runBatonCleanup(
            { callerSessionId: caller.callerSessionId, toolName: 'archive_plan' },
            {
              shutdownTeammates: handlerDeps?.shutdownTeammates,
              archiveSession: handlerDeps?.archiveSession,
            },
          );
        } catch (cleanupErr) {
          // baton cleanup 自身抛错只 warn 不阻塞 — 主诉求是透传 impl 的 post-ff-merge error
          logger.warn(
            `[mcp archive_plan] post-commit baton cleanup threw while handling post-ff-merge error (continuing to surface impl error):`,
            cleanupErr,
          );
        }
      }
      return err(result.error, result.hint);
    }

    // CHANGELOG_109(R37 P2-M Step 3.5)：baton cleanup 两段(teammate shutdown + archive caller)
    // 收口到 runBatonCleanup helper(详 baton-cleanup.ts 顶部 jsdoc)。helper 内部串行跑 phase 1
    // → phase 2,失败容错全在 helper 里(单个 close warn / helper 抛错兜底 / archive 失败 warn);
    // handler 这层只透传 input + 把两个三态结果 spread 进 ok return。
    //
    // 时序保证(必须 phase 1 → phase 2):由 helper 内部 await 串行保证;handler 不能颠倒调用顺序。
    //
    // archive_plan 不传 excludeSessionIds(plan 收口前不 spawn 新 session)。plan
    // hand-off-session-adopt-teammates-20260520 Phase 3 简化:删除 baton-cleanup phase 1
    // opt-out 字段,archive_plan 永远跑真 helper 关 teammate(plan 完成 = team 整片收口)。
    const cleanup = await runBatonCleanup(
      {
        callerSessionId: caller.callerSessionId,
        toolName: 'archive_plan',
      },
      {
        shutdownTeammates: handlerDeps?.shutdownTeammates,
        archiveSession: handlerDeps?.archiveSession,
      },
    );

    return ok({
      archivedPath: result.archivedPath,
      commitHash: result.commitHash,
      branchDeleted: result.branchDeleted,
      worktreeRemoved: result.worktreeRemoved,
      plansIndexAction: result.plansIndexAction,
      finalStatus: result.finalStatus,
      // REVIEW_56 §F9 修法: handler 端 mergeCallerCwd fail-open warnings prepend 到 impl warnings,
      // 让 caller 看到 sessionRepo.get throw / row missing / cwd invalid 等 fail-open 退化
      // (修前 P5 R1 只 console.warn 到 operator log,caller silent 不知)。
      warnings: [...callerCwdWarnings, ...result.warnings],
      /**
       * R3 follow-up (spike-reports/ 归档): spike artifacts 自动归档结果。
       * - `null`: plan 无 spike (`<plan-artifact-dir>/spike-reports/` 不存在), skip
       * - `{ srcPath, dstPath }`: spike-reports/ 成功 mv 入归档 commit 与 plan .md 平级
       *
       * mv 失败时 spikeReportsArchived 仍为 null 但 result.warnings 含 spike-reports archive failed
       * 详细 hint (caller 手工 `mkdir -p && mv && git add+commit --amend` 补归档)。
       *
       * Handler 直接透传 impl ArchivePlanResult.spikeReportsArchived 引用（impl 已 camelCase；
       * 历史上 handler 做过 snake_case 转换，统一 camelCase 后已删 — CHANGELOG_148）。
       */
      spikeReportsArchived: result.spikeReportsArchived,
      /**
       * CHANGELOG_99：'ok' = caller 归档成功 / 'failed' = warn-only 不阻塞(callerRow 缺 / DB
       * 不可用 / archive 抛错) / 'skipped' = external caller(理论上 deny external 拦截不到这里)
       */
      archived: cleanup.archived,
      /**
       * CHANGELOG_106：teammate shutdown 详情 — { closed: string[], failed: Array<{sessionId,reason}>,
       * skipped: 'caller-not-lead' | 'adopt-keep-implicit' | null }(plan
       * hand-off-session-adopt-teammates-20260520 Phase 3 删 phase 1 opt-out 字段后,
       * archive_plan 路径下 skipped 仅 'caller-not-lead' / null 两值)。
       * - closed: 成功 close 的 teammate sid 列表(已 dedup 跨 team 共享同 sid)
       * - failed: close 失败的 teammate(含 reason),warn 不阻塞 ok return
       * - skipped: 'caller-not-lead'(caller 不是 lead) /
       *   null(正常处理含 closed=[] 的 caller=lead 但 team 内无其他 teammate)
       */
      teammatesShutdown: cleanup.teammatesShutdown,
    } satisfies ArchivePlanResult);
  },
);
