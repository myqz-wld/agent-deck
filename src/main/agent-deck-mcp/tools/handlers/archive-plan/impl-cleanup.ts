/**
 * archive-plan-impl Step 13-14 cleanup 子模块 (plan deep-project-review-comprehensive-20260528
 * Step 4.2 拆分产物)。
 *
 * **职责**: archive-fs 通过后跑 git add + commit (含 pathspec 隔离 + 无关 dirty 注脚),拿
 * archiveCommit hash,清 cwdReleaseMarker (如有 hold),最后 worktree remove + branch -D。
 * 任一步失败 main HEAD 已动 → postFfMergeErr。
 *
 * **业务流程** (与原 archive-plan-impl.ts:990-1157 1:1 对齐):
 * 1. Step 13a: filesToAdd 派生 (archivedPath + indexPath + 可选 planRelative + spikeReports.dstPath)
 *    含 source tracked precheck (planRelative push 前 ls-files --error-unmatch 看 git index 视角)
 * 2. Step 13: git add — line 1039-1049
 * 3. Step 13b: commit msg 派生 (含 mainRepo unrelated dirty sample 注脚) + git commit (pathspec 隔离) — line 1050-1090
 * 4. Step 13c: archiveCommit rev-parse (REVIEW_56 Batch B R1 MED-1) — line 1092-1114
 * 5. Step 13d: clearCwdReleaseMarker (releaseMarkerOnSuccess 时,CHANGELOG_169 F10 marker
 *    release 时序前移到 archive 本质完成后) — line 1116-1137
 * 6. Step 14a: git worktree remove — line 1139-1148
 * 7. Step 14b: git branch -D — line 1149-1157
 *
 * **不变量**:
 * - commit pathspec 隔离 (`git commit -- <pathspec>`): 显式只 commit archivedPath / indexPath /
 *   planRelative (可选) / spike-reports.dstPath (可选), 不吞 mainRepo 预存 staged
 *   (CHANGELOG_169 F2 D3 不变量 4)
 * - source tracked precheck: planRelative push 前用 ls-files --error-unmatch 看 git index 视角,
 *   exitcode 0 → tracked → push (git add 处理 deletion); 非 0 → untracked/ignored → skip
 *   (典型本项目 `.claude/plans/` ignored case,git history 本来不含不需记 deletion)
 * - marker release 时序: Step 13c rev-parse 都成功后 release (archive 本质完成),Step 14a/14b
 *   失败时 marker 已清 caller 重新跑别 plan 不撞 stale marker (CHANGELOG_169 F10)
 */

import * as path from 'node:path';

import { postFfMergeErr } from './_impl-shared';
import type {
  ArchivePlanDeps,
  ArchivePlanError,
  ArchivePlanInput,
  CleanupResult,
} from './_impl-shared';

/**
 * Step 13-14 cleanup 主体。
 *
 * **Input ctx**:
 *   - mainRepo / worktreeBranch / planFilePath / archivedPath / indexPath (precheck 派生)
 *   - spikeReportsArchived (archive-fs 输出 — 可选,non-null 时进 filesToAdd)
 *   - releaseMarkerOnSuccess (precheck 输出 — true 时 archive 本质完成后调 clearCwdReleaseMarker)
 *   - mainRepoClean.warnings (precheck 输出 — Step 13b commit msg 注脚用)
 *
 * **Side effects** on warnings 数组(共享 ref): clearCwdReleaseMarker fail (Step 13d release 失败,
 *   archive 已 commit 成功不阻塞 ok return)。
 *
 * **Return**: CleanupResult { archiveCommit, branchDeleted, worktreeRemoved } / ArchivePlanError on fail。
 */
export async function runCleanup(
  input: ArchivePlanInput,
  deps: Required<ArchivePlanDeps>,
  warnings: string[],
  ctx: {
    mainRepo: string;
    worktreeBranch: string;
    planFilePath: string;
    archivedPath: string;
    indexPath: string;
    spikeReportsArchived: { srcPath: string; dstPath: string } | null;
    releaseMarkerOnSuccess: boolean;
    mainRepoClean: { warnings: Array<{ status: string; path: string }> };
  },
): Promise<CleanupResult | ArchivePlanError> {
  const {
    mainRepo,
    worktreeBranch,
    planFilePath,
    archivedPath,
    indexPath,
    spikeReportsArchived,
    releaseMarkerOnSuccess,
    mainRepoClean,
  } = ctx;

  // 13. git add + commit
  // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.10 修法 (B-MED-1 codex):
  // 修前 filesToAdd 只含 archivedPath / indexPath,如果 source planFilePath 不等于
  // archivedPath(典型本项目惯例 source 在 `<main-repo>/.claude/plans/<id>.md`)且 source 是
  // tracked file → step 12 unlink 已把 source 从 working tree 移走但 git index 不知道,
  // 归档 commit 只含「+archivedPath」不含「-source」,git status 仍显示「deleted: source」未
  // 入 commit,用户后续 `git status` 看到 confusing pending deletion。修法:source 在 mainRepo
  // 子树内 + source ≠ archivedPath → 把 source 相对路径加入 filesToAdd(git add 处理 deletion
  // = stage 文件删除)。source 不在 mainRepo 子树内(如 `~/.claude/plans/` 全局位置) → 不加
  // (不污染 mainRepo git history)。
  //
  // **plan hand-off-session-adopt-teammates-20260520 follow-up bug fix**:
  // 上面修法漏判 source ignored / untracked 路径(典型本项目 `.claude/plans/` 在 `.gitignore`
  // 从未 git tracked)。这种 source 文件:① 真实存在 fs ② step 12 unlink 移走 ③ 不在 git
  // index 内 → planRelative push 后 git add 撞 `did not match any files` post-ff-merge fail。
  // 修法:planRelative push 前用 `git ls-files --error-unmatch` precheck source tracked,
  // exitcode 0(tracked)才 push;exitcode 非 0(untracked / ignored)skip 不 push(git
  // history 本来就不含,不需要记 deletion)。
  const filesToAdd = [
    path.relative(mainRepo, archivedPath),
    path.relative(mainRepo, indexPath),
  ];
  const planRelative = path.relative(mainRepo, planFilePath);
  if (
    path.resolve(planFilePath) !== path.resolve(archivedPath) &&
    !planRelative.startsWith('..') &&
    !path.isAbsolute(planRelative)
  ) {
    // precheck source 是否 git tracked。`git ls-files --error-unmatch <path>` exitcode 0 =
    // tracked / 非 0 = untracked / ignored / typo。runGit throws on non-zero exit → 用
    // try/catch 区分两态。本路径在 step 12 unlink 之后跑,源文件已不在 fs;但 git index
    // 仍可能记 tracked 状态(刚 unlink 还没 stage 删除)→ ls-files 看 index 视角。
    let sourceTracked = false;
    try {
      await deps.runGit(['ls-files', '--error-unmatch', planRelative], mainRepo);
      sourceTracked = true;
    } catch {
      // exitcode 非 0:source 在 .gitignore / 从未 tracked / 路径 typo → skip,git history
      // 本来不含 source 不需要记 deletion(典型本项目 .claude/plans/ ignored case)。
      sourceTracked = false;
    }
    if (sourceTracked) {
      filesToAdd.push(planRelative);
    }
  }
  // R3 follow-up: spike-reports/ 子目录入 filesToAdd 让 git add 递归处理整个目录
  if (spikeReportsArchived !== null) {
    filesToAdd.push(path.relative(mainRepo, spikeReportsArchived.dstPath));
  }
  try {
    await deps.runGit(['add', ...filesToAdd], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'git-add',
      e as Error,
      `git add failed (rare — git lock / index corrupt / paths outside main repo). ` +
        `Fix git lock (rm .git/index.lock if stale) then manually \`git -C ${mainRepo} add ${filesToAdd.join(' ')}\`; ` +
        `complete steps 13b-14 manually (git commit / worktree remove / branch -D).`,
    );
  }
  // **R3 fix-7 (M4 codex Batch B MED-1)**: commit message 加 mainRepo unrelated dirty 注脚,
  // 让归档 commit 有可审计 trail 表明本归档时 mainRepo 还有 N 个无关 dirty 文件（不会被
  // pathspec 吞,但归档时刻状态可追溯）。caller 看 git log 能立刻判断「这次归档时 mainRepo
  // 有其他未 commit 改动」,与 ok return warnings 字段冗余但 commit history 比 ok return
  // 持久（caller 不一定看 ok return,但 git log 一直在）。
  let commitMsg = `docs(plans): 归档 ${input.planId} plan + 同步 INDEX (archive_plan)`;
  if (mainRepoClean.warnings.length > 0) {
    const sample = mainRepoClean.warnings
      .slice(0, 3)
      .map((w) => `${w.status} ${w.path}`)
      .join(', ');
    const sampleSuffix = mainRepoClean.warnings.length > 3 ? '...' : '';
    commitMsg += `\n\nNote: ${mainRepoClean.warnings.length} unrelated dirty file${mainRepoClean.warnings.length === 1 ? '' : 's'} in main repo at archive time (excluded from this commit by pathspec). Sample: ${sample}${sampleSuffix}.`;
  }
  try {
    // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 4 修法 (D3 F2 不变量 4)**:
    // 显式 pathspec 隔离归档 commit 只含 plan / INDEX / archived plan path 三类归档文件，
    // 不吞 mainRepo 预存 staged。修前 `git commit -m <msg>` 默认 commit 所有 staged
    // → 如果 mainRepo 之前已 stage 其他文件（如 caller 在跑 archive_plan 之前手工 git add 过
    // 其他 file，或 step 13 之前的 step 偶然 stage 文件）会一起进归档 commit，污染归档语义
    // 「只含归档相关变更」+ 让归档 commit 包含与 plan 完全无关的代码。
    //
    // **不变量 4 兑现**：archive_plan commit 隔离 — `git commit -- <pathspec>` 显式只包含
    // plan / INDEX / changelog 三类归档文件，不吞 mainRepo 预存 staged。
    //
    // **F2 真根因复诊**（lead 现场验证）：本会话上轮归档撞 mainRepo 9 staged + 4 untracked →
    // B-HIGH-4 precheck fail-fast 拦下 → 用户走手工归档绕过 archive_plan tool → runBatonCleanup
    // 没被调到 → 6 旧 reviewer 自然衰减成 dormant 但**没** closed。F2 修法本质 = commit
    // pathspec 显式隔离 + mainRepo precheck 精确化（仅 reject path ∈ {archivedPath, indexPath,
    // planFilePath} 三具体路径，其他 dirty 降 warning + commit message 注脚）— 后者已 land
    // (Phase 1.2 副作用，详 plan 当前进度)，本 step 仅修 commit pathspec。
    await deps.runGit(['commit', '-m', commitMsg, '--', ...filesToAdd], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'git-commit',
      e as Error,
      `git commit failed (pre-commit hook reject / commit-msg validator failed / nothing to commit / signing key issue). ` +
        `Inspect the git error and fix root cause (skip hook with --no-verify only if necessary, fix message format, configure signing key); ` +
        `then manually \`git -C ${mainRepo} commit -m "${commitMsg}" -- ${filesToAdd.join(' ')}\` and complete step 14 manually (worktree remove / branch -D).`,
    );
  }

  // **REVIEW_56 Batch B R1 MED-1 修法 (reviewer-codex)**: archive commit 之后重新拿 HEAD 作
  // archiveCommit return 给 caller。
  // 修前 commitHash = finalCommit(line 807 ff-merge HEAD = worktree branch tip)— caller 拿到的
  // hash 不能定位包含 status=completed / INDEX 更新 / spike-reports 归档的 archive commit。
  // 修后:
  //  - finalCommit (worktree merge tip) 仍写 plan frontmatter `final_commit` 字段(语义: caller
  //    实际工作的最后 commit,反向追溯 worktree 进度合理)
  //  - archiveCommit (archive commit) return 给 caller 的 commitHash(语义: 归档操作 commit,
  //    含 status=completed / INDEX / spike-reports / changelog 引用)
  // 两个 hash 分别承载不同语义,caller 拿 commitHash 能定位归档 commit;archived plan frontmatter
  // 内 final_commit 仍指向 caller 工作终态。
  let archiveCommit: string;
  try {
    archiveCommit = await deps.runGit(['rev-parse', 'HEAD'], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'archive-rev-parse-HEAD',
      e as Error,
      `git rev-parse HEAD failed in main repo after archive commit (rare — git internal state). ` +
        `Manually run \`git -C ${mainRepo} rev-parse HEAD\` to get archive commit hash. Archive commit succeeded; ` +
        `step 14 (worktree remove / branch -D) still needs running.`,
    );
  }

  // CHANGELOG_169 F10 [MED] 修法 (reviewer-claude finding): marker release 从 step 14b 后挪到
  // step 13 commit + step 13c rev-parse 都成功之后(即 archive 本质完成后,step 14 worktree
  // remove / branch -D 仅是 git artifacts 清理)。
  //
  // 修前 marker release 排在 step 14b branch -D 之后,step 14a/14b 失败时 marker 残留;但 plan
  // 已 commit + INDEX 更新 + frontmatter status=completed → caller 不能重试 archive_plan
  // (step 5 plan status check 撞 already completed reject),marker 残留对**本 planId** 无
  // 功能影响,但若 caller session 后续再调 archive_plan 跑别的 planId,step 4 4-state cwd
  // dispatch 时这个 stale marker 会指向已不存在的 worktree → 走 4-state 分流 (d) 路径 reject。
  //
  // 修后:archive 本质完成 → 立即 release marker;step 14 worktree remove/branch -D 失败时
  // marker 已清,caller 重新跑别 plan 不撞 stale marker bug。release 失败仅 warn 不阻塞 ok
  // return(archive 已成功,marker 残留属轻微 leak)。
  if (releaseMarkerOnSuccess) {
    try {
      await deps.clearCwdReleaseMarker();
    } catch (e) {
      warnings.push(
        `archive succeeded but clearCwdReleaseMarker failed: ${(e as Error).message}. Caller may need to manually clear via exit_worktree or session close.`,
      );
    }
  }

  // 14. git worktree remove + branch -D
  // Follow-up #6: worktree remove 带 --force。precheck 已验 worktree clean,但 precheck→实删
  // 窗口被外部写脏时 `git worktree remove`(无 --force)会失败,hint 反而建议 --force(实现与
  // 文案矛盾)。--force 兜底 race window 写脏,与 hint 文案 + 中止流程手动命令(user CLAUDE.md
  // §Step 4 中止 `git worktree remove --force`)对齐。
  try {
    await deps.runGit(['worktree', 'remove', '--force', input.worktreePath], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'git-worktree-remove',
      e as Error,
      'Worktree remove failed even with --force (rare: worktree locked / nested git op / fs permission). Manually run `git worktree remove --force` and `git branch -D`.',
    );
  }
  try {
    await deps.runGit(['branch', '-D', worktreeBranch], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'git-branch-D',
      e as Error,
      'Branch may already be deleted. Worktree was already removed; commit + merge already done.',
    );
  }

  return {
    archiveCommit,
    branchDeleted: worktreeBranch,
    worktreeRemoved: input.worktreePath,
  };
}
