/**
 * archive_plan handler 的实现层 facade — git / fs / frontmatter 业务逻辑入口 (plan
 * mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.2 +
 * plan deep-project-review-comprehensive-20260528 Step 4.2 拆分)。
 *
 * **本文件职责** (Step 4.2 拆分后):
 * - facade re-export 全部 public types (test seam + handler 同款 import path 零改动)
 * - archivePlanImpl 主入口 (thin orchestrator,串联 4 子模块 + isError 路径短路)
 * - re-export precheck-helpers / index-sync-helpers (历史 test seam 不动)
 * - re-export _impl-shared 的 isError as `_isArchivePlanError` (test seam)
 *
 * **业务流程** (user CLAUDE.md §Step 4 cleanup 的 5 步 Bash 1:1 自动化, 行级 step 边界见 4 子模块 jsdoc):
 *
 * - **precheck** (Step 1-6 + 6.5): 解析 worktree → mainRepo + branch + clean + planFile + status
 *   + frontmatter cross-check + cwd 4 态分流 — 详 archive-plan/impl-precheck.ts
 * - **ff-merge** (Step 7-8c): baseBranch 校验 + checkout + merge --ff-only + 重新 read fresh
 *   plan + 校验 fresh status — 详 archive-plan/impl-ff-merge.ts
 * - **archive-fs** (Step 9-12.5): 更新 frontmatter + 写 archived plan + 同步 INDEX + unlink 原 plan
 *   + 归档 spike-reports/ — 详 archive-plan/impl-archive-fs.ts
 * - **cleanup** (Step 13-14): git add + commit (pathspec 隔离) + archiveCommit rev-parse + 清
 *   cwdReleaseMarker + worktree remove + branch -D — 详 archive-plan/impl-cleanup.ts
 *
 * 任一步失败立即返回 error（短路），不做部分回滚（git 操作不可逆，需要 caller 手工修）。
 *
 * **deps inject 模式**：默认实现走 Node 内置（child_process.execFile + fs/promises +
 * os.homedir + process.cwd），test 通过传 `deps` 参数完全替换为 in-memory mock。
 *
 * **拆分动机** (Step 4.2): 1281 LOC inline archivePlanImpl + 14 step phase 边界,4 子模块按
 * phase 行为域拆分使每个文件 ≤ 500 LOC 护栏 + 行级精确对齐原步骤,facade 仅 ~150 LOC
 * orchestrator。跨子模块 state 通过函数 return value 传递(Step 4.1 经验),避免单一巨型
 * ctx object 闭包污染。
 */

import { runArchiveFs } from './archive-plan/impl-archive-fs';
import { runCleanup } from './archive-plan/impl-cleanup';
import { runFfMerge } from './archive-plan/impl-ff-merge';
import { runPrecheck } from './archive-plan/impl-precheck';
import { DEFAULT_DEPS, isError } from './archive-plan/_impl-shared';
import type {
  ArchivePlanDeps,
  ArchivePlanError,
  ArchivePlanInput,
  ArchivePlanResult,
} from './archive-plan/_impl-shared';

// ===========================================================================
// public types — facade re-exports (test + handler import 路径零改动)
// ===========================================================================

export type {
  ArchivePlanInput,
  ArchivePlanResult,
  ArchivePlanError,
  ArchivePlanDeps,
  PostFfMergePhase,
} from './archive-plan/_impl-shared';

// Step 4.12 R1 codex HIGH-1 fix: facade byte-identical re-export contract — baseline
// 9a03b46 archive-plan-impl.ts:1266 直接 export function postFfMergeErr (value export),
// 拆分后函数移到 ./archive-plan/_impl-shared.ts 必须从 facade re-export 让旧 caller
// `from '@main/agent-deck-mcp/tools/handlers/archive-plan-impl'` 仍能拿到该 value。
export { postFfMergeErr } from './archive-plan/_impl-shared';

// ===========================================================================
// precheck-helpers re-export (Step 4.2 前的 CHANGELOG_169 F1 Step 1.2 抽出层不动)
// ===========================================================================
export {
  assertMainRepoCleanForArchive,
  assertBaseBranchIsNamedBranch,
} from './archive-plan/precheck-helpers';
export type {
  AssertMainRepoCleanInput,
  AssertMainRepoCleanResult,
  AssertBaseBranchInput,
  AssertBaseBranchResult,
  MainRepoStatusEntry,
} from './archive-plan/precheck-helpers';

// ===========================================================================
// index-sync-helpers re-export (Step 4.2 前的 CHANGELOG_169 F1 Step 1.3 抽出层不动)
// ===========================================================================
export {
  escapeTableCell,
  formatChangelogCell,
  syncPlansIndex,
} from './archive-plan/index-sync-helpers';
export type {
  PlansIndexAction,
  SyncPlansIndexOptions,
  SyncPlansIndexResult,
} from './archive-plan/index-sync-helpers';

// ===========================================================================
// archivePlanImpl thin orchestrator — 4 子模块串联 + 短路返回 error
// ===========================================================================

/**
 * archive_plan 主入口。
 *
 * **Step 4.2 拆分后** (与原 1025 LOC inline 行级 1:1 对齐):
 * - merge depsOverride with DEFAULT_DEPS (default Node fs/git/realpath/cwd)
 * - 初始化共享 warnings 数组(子模块 push warning 进去,最终 ok return 透传)
 * - 4 子模块串联: runPrecheck → runFfMerge → runArchiveFs → runCleanup
 *   每个子模块返回 result | ArchivePlanError; 后者立即 return 短路
 * - 构造 ok return: 字段从 precheck.archivedPath + cleanup.{archiveCommit, branchDeleted,
 *   worktreeRemoved} + archive-fs.{plansIndexAction, spikeReportsArchived} + warnings 拼装
 *
 * **不变量**:
 * - 子模块间 state 通过函数 return value 传递(避免单一巨型 ctx object,Step 4.1 经验),
 *   facade 只负责解构 + 透传
 * - warnings 数组共享 ref (4 子模块 push warning 进同一份),不通过 return 传递避免每层 spread
 */
export async function archivePlanImpl(
  input: ArchivePlanInput,
  depsOverride?: ArchivePlanDeps,
): Promise<ArchivePlanResult | ArchivePlanError> {
  const deps: Required<ArchivePlanDeps> = { ...DEFAULT_DEPS, ...depsOverride };
  // archive-plan-tool-ux-followup-20260515 HIGH-2:non-fatal warning 数组(silent override 防覆盖等
  // 场景的 warn 收集口子)。impl 走完所有步骤都成功才会 return ok + warnings 透传 caller。
  const warnings: string[] = [];

  // precheck (Step 1-6 + 6.5 + worktreeBranch 命名约束)
  const precheckResult = await runPrecheck(input, deps, warnings);
  if (isError(precheckResult)) return precheckResult;
  const {
    mainRepo,
    worktreeBranch,
    planFilePath,
    fm,
    archivedDir,
    archivedPath,
    indexPath,
    mainRepoClean,
    releaseMarkerOnSuccess,
  } = precheckResult;

  // ff-merge (Step 7-8c)
  const ffMergeResult = await runFfMerge(input, deps, {
    mainRepo,
    worktreeBranch,
    planFilePath,
    fm,
  });
  if (isError(ffMergeResult)) return ffMergeResult;
  const { finalCommit, freshContent, freshFm } = ffMergeResult;

  // archive-fs (Step 9-12.5)
  const archiveFsResult = await runArchiveFs(input, deps, warnings, {
    mainRepo,
    planFilePath,
    archivedDir,
    archivedPath,
    indexPath,
    freshFm,
    freshContent,
    finalCommit,
  });
  if (isError(archiveFsResult)) return archiveFsResult;
  const { plansIndexAction, spikeReportsArchived } = archiveFsResult;

  // cleanup (Step 13-14)
  const cleanupResult = await runCleanup(input, deps, warnings, {
    mainRepo,
    worktreeBranch,
    planFilePath,
    archivedPath,
    indexPath,
    spikeReportsArchived,
    releaseMarkerOnSuccess,
    mainRepoClean,
  });
  if (isError(cleanupResult)) return cleanupResult;
  const { archiveCommit, branchDeleted, worktreeRemoved } = cleanupResult;

  return {
    archivedPath,
    commitHash: archiveCommit,
    branchDeleted,
    worktreeRemoved,
    plansIndexAction,
    finalStatus: 'completed',
    warnings,
    spikeReportsArchived,
  };
}

// ===========================================================================
// internal-use re-exports for test seam (_isArchivePlanError)
// ===========================================================================

/**
 * 测试 helper:isError type guard 别名,test 文件通过 `_isArchivePlanError` 判 result
 * union 分流 (避免暴露 `isError` 公共名易撞 lodash 等三方库)。
 */
export { isError as _isArchivePlanError };
