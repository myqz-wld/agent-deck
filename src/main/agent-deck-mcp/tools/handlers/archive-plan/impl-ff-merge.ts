/**
 * archive-plan-impl Step 7-8c ff-merge 子模块 (plan deep-project-review-comprehensive-20260528
 * Step 4.2 拆分产物)。
 *
 * **职责**: precheck 通过后跑 ff-merge,将 worktree branch 合到 baseBranch,然后重新 read
 * fresh plan + 校验 fresh status。任一步失败走 postFfMergeErr (Step 8 / 8b 例外:Step 8b
 * 走 postFfMergeErr 但 caller 应该用 `git reset --hard ORIG_HEAD` 干净回滚 — 唯一允许的
 * post-ff-merge reset 路径,详 _impl-shared.ts §PostFfMergePhase jsdoc)。
 *
 * **业务流程** (与原 archive-plan-impl.ts:636-798 1:1 对齐):
 * 1. Step 7: fast-forward merge (effectiveBaseBranch 派生 + assertBaseBranchIsNamedBranch
 *    校验 + checkout base + merge --ff-only) — line 636-681
 * 2. Step 8: 拿 finalCommit (worktree branch tip = main HEAD post-merge) — line 683-695
 * 3. Step 8b: 重新 read planFilePath + parse fresh frontmatter
 *    (plan archive-plan-content-overwritten-fix-20260515 修法 A) — line 697-735
 * 4. Step 8c: 重新校验 freshFm.status === 'in_progress'
 *    (R1 review 反驳轮异构同源共识 HIGH) — line 737-798
 *
 * **不变量**:
 * - **post-ff-merge 写入路径**: Step 8b 之后向 fs 写入的内容必须从 freshFm / freshContent 读取,
 *   严禁回到 step 6 fm / planContent (R1 review 双方共识)
 * - Step 7 之后任何失败都 main HEAD 已动 → 必须走 postFfMergeErr 并附 phase + manual recovery hint
 */

import {
  parseFrontmatter,
} from '@main/utils/frontmatter';

import { assertBaseBranchIsNamedBranch } from './precheck-helpers';
import { postFfMergeErr } from './_impl-shared';
import type {
  ArchivePlanInput,
  ArchivePlanDeps,
  ArchivePlanError,
  FfMergeResult,
} from './_impl-shared';

import * as path from 'node:path';

/**
 * Step 7-8c ff-merge 主体。
 *
 * **Input ctx** from runPrecheck return: mainRepo / worktreeBranch / planFilePath / fm
 *   - mainRepo: 跑 git checkout / merge 的 cwd
 *   - worktreeBranch: ff-merge 源 (合到 baseBranch)
 *   - planFilePath: Step 8b 重新 read 的 path
 *   - fm: Step 7 baseBranch fallback 用 (caller 不显式传 baseBranch 时读 frontmatter.base_branch)
 *
 * **Return**: FfMergeResult { finalCommit, freshContent, freshFm } / ArchivePlanError on fail。
 */
export async function runFfMerge(
  input: ArchivePlanInput,
  deps: Required<ArchivePlanDeps>,
  ctx: {
    mainRepo: string;
    worktreeBranch: string;
    planFilePath: string;
    fm: Record<string, string>;
  },
): Promise<FfMergeResult | ArchivePlanError> {
  const { mainRepo, worktreeBranch, planFilePath, fm } = ctx;

  // 7. fast-forward merge worktree branch → baseBranch
  // REVIEW_33 H1：旧实现直接 `git merge --ff-only worktreeBranch` 在 mainRepo 当前 HEAD 上 ff，
  // 与「ff merge into baseBranch」契约不符——caller 当前 checkout 在 feature-x 时把 worktree
  // branch 合进 feature-x 而非 main。修法：merge 前先 verify baseBranch 存在 + checkout 到
  // baseBranch（merge 后不切回，假设 caller 默认在 baseBranch 工作；如不在 caller 自己处理）。
  //
  // REVIEW_36 R2 user feedback：baseBranch 解析优先级 = caller 显式 input.baseBranch >
  // plan frontmatter.base_branch (plan 创建时记录) > "main" fallback。旧 schema `.default('main')`
  // 让 caller 不传时强制合到 main，feature branch 上跑 plan 会污染主线。frontmatter 字段让用户
  // 在 plan 创建时记录原分支（user CLAUDE.md §Step 2 plan 内容文档已加该字段说明）。
  // REVIEW_68 batch-3: plan frontmatter snake_case（CHANGELOG_177 合法保留）。camelcase
  // migration（commit 5ff0d78）误读成 fm.baseBranch → snake-only feature-branch plan 的
  // base_branch 被忽略 fallback "main" → ff-merge 错合主线。读 snake_case key 回正。
  const fmBaseBranch = typeof fm.base_branch === 'string' ? fm.base_branch.trim() : '';
  const effectiveBaseBranch =
    input.baseBranch !== undefined && input.baseBranch.length > 0
      ? input.baseBranch
      : fmBaseBranch.length > 0
        ? fmBaseBranch
        : 'main';
  // B-HIGH-3 修法（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）— 抽 lambda
  // export `assertBaseBranchIsNamedBranch`（plan deep-review-batch-a1-b-followup-r3-20260519
  // §Phase 1.2b / D6），handler 调真实 lambda 而非 inline 复制合约（H4 教训）。
  const baseBranchCheck = await assertBaseBranchIsNamedBranch(
    { runGit: deps.runGit },
    { mainRepoAbsPath: mainRepo, baseBranch: effectiveBaseBranch },
  );
  if (!baseBranchCheck.ok) {
    return {
      error: baseBranchCheck.error ?? `baseBranch validation failed for "${effectiveBaseBranch}"`,
      hint: baseBranchCheck.hint,
    };
  }
  try {
    await deps.runGit(['checkout', effectiveBaseBranch], mainRepo);
  } catch (e) {
    return {
      error: `git checkout ${effectiveBaseBranch} failed in main repo: ${(e as Error).message}`,
      hint: `Caller cwd or main repo state may prevent branch switch (uncommitted changes / pre-commit hooks). Resolve and retry.`,
    };
  }
  try {
    await deps.runGit(['merge', '--ff-only', worktreeBranch], mainRepo);
  } catch (e) {
    return {
      error: `git merge --ff-only ${worktreeBranch} failed in main repo: ${(e as Error).message}`,
      hint: `${effectiveBaseBranch} cannot be fast-forwarded to ${worktreeBranch}. Manually rebase or merge first.`,
    };
  }

  // 8. 拿最终 commit hash
  let finalCommit: string;
  try {
    finalCommit = await deps.runGit(['rev-parse', 'HEAD'], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'rev-parse-HEAD',
      e as Error,
      `git rev-parse HEAD failed in main repo (rare — git internal state / perm). ` +
        `Manually run \`git -C ${mainRepo} rev-parse HEAD\` to get current hash; ` +
        `complete steps 9-14 manually (update plan frontmatter with status=completed + final_commit + completed_at, write to ${path.join(mainRepo, 'ref', 'plans', `${input.planId}.md`)}, sync ref/plans/INDEX.md, unlink original plan, git add+commit, worktree remove, branch -D).`,
    );
  }

  // 8b. **重新 read plan 文件 + parse fresh frontmatter**
  //
  // plan archive-plan-content-overwritten-fix-20260515 修法 A:拆两次 read。
  //
  // **bug 根因**:旧实现 step 6 在 ff-merge **之前** read planContent → step 7 ff-merge
  // 把 worktree branch 上 caller 的最后一笔 plan 回写带进 main working tree → step 10
  // 用 step 6 读的旧 planContent.body + 改 frontmatter 写新文件 → ff-merge 进来的 caller
  // 回写(典型 Phase 5 收尾 commit:[x] step checklist / 跳过理由 / 已知踩坑修正等)被覆盖。
  //
  // **修法**:ff-merge 成功后(step 7-8 之后)重新 read planContent 拿 fresh body + fm,
  // 之后 step 9 / step 10 / step 11 全部用 freshFm + freshContent(step 11 INDEX summary
  // 是 R1 review HIGH-A fix 加入的 carry-forward 点)。预检阶段(step 6)的 fm 仍用于
  // status check / baseBranch fallback / fm 元数据派生(已用完),不再参与 step 10 /
  // step 11 写入。**post-ff-merge 写入路径不变量**:任何 step 8c 之后向 fs 写入的内容
  // 必须从 freshFm / freshContent 读取,严禁回到 step 6 fm / planContent —— 未来添加新
  // post-ff-merge step 时务必遵守该 invariant(R1 review 双方共识)。
  //
  // **失败兜底**:fresh re-read fail → postFfMergeErr (与其他 post-ff-merge 失败统一姿势:
  // 报 phase prefix + 通用 hint「ff-merge 已完成,按 phase 手工补完」,不做自动 git revert
  // 保持与 step 8/10/11/12/13/14 既有 post-ff-merge 失败处理风格一致)。
  let freshContent: string;
  try {
    freshContent = await deps.readFile(planFilePath);
  } catch (e) {
    return postFfMergeErr('reread-plan-after-ffmerge', e as Error);
  }
  const freshFm = parseFrontmatter(freshContent);
  if (Object.keys(freshFm).length === 0) {
    // 边角:caller 在 worktree branch 上把 frontmatter block 删了(误操作),ff-merge 后
    // main 拿到的 plan 没有 frontmatter。step 6 fm 已用完不能 fallback(也不该 fallback —
    // 用 step 6 fm + fresh body 的混合状态语义更乱)。直接报错让 caller 手工修后再调。
    return postFfMergeErr(
      'reread-plan-after-ffmerge',
      new Error(
        `plan file at ${planFilePath} has no parseable frontmatter after ff-merge ` +
          `(caller may have stripped the frontmatter block on the worktree branch)`,
      ),
    );
  }

  // 8c. **重新校验 fresh status**(R1 review 反驳轮异构同源共识 HIGH)
  //
  // **bug 根因**:本次 fix(plan archive-plan-content-overwritten-fix-20260515 Phase 1+2)
  // 把 step 9 spread 来源从 step 6 fm 切到 freshFm,但 step 6 的 status 三档分流校验
  // (line 250/259/265)没同步迁移到 step 8b。caller 若在 worktree branch commit 把
  // plan status 改 abandoned / completed / 未知值,ff-merge 把改动带进 main → step 9
  // `{ ...freshFm, status: 'completed' }` 会静默把 abandoned plan 强制归档成 completed,
  // 违反 user CLAUDE.md §Step 4「中止」契约 + 回归 REVIEW_33 H2 已修过的 abandoned 防线。
  //
  // **现实场景**(reviewer-claude 反驳轮列举):
  // - Scenario A:caller worktree commit `status: abandoned` → 改主意继续推进 fix → 忘改回
  // - Scenario B:hand_off_session 跨会话漂移,Session 2 接力没注意 frontmatter 变更
  // - Scenario C:多人 / 多 agent 协作,A commit abandoned 意向 → B 接管完成 → 调 archive
  //
  // **修法**:8c re-check `freshFm.status === 'in_progress'`,否则 postFfMergeErr 拒绝。
  // 不再细分三档(step 6 preflight 已细分):post-ff-merge 阶段 main HEAD 已动,cleanup
  // 路径需 caller inspect 真实意图后 git revert + edit fm 再 retry,统一专用 phaseHint。
  if (freshFm.status !== 'in_progress') {
    return postFfMergeErr(
      'reread-plan-after-ffmerge',
      new Error(
        `plan status changed to "${freshFm.status ?? '<missing>'}" on the worktree branch ` +
          `(was "in_progress" at preflight). archive_plan only handles in_progress → completed; ` +
          `cannot proceed with non-in_progress fresh status to avoid violating user CLAUDE.md ` +
          `§Step 4 "中止" contract (abandoned plans must not enter project git archive).`,
      ),
      // R2 MED 1 修法:`--ff-only` 可带入 worktree branch 多个 commit(实测本 plan 收口
      // 时已 4+ commit ahead of main),`git revert HEAD` 仅撤 tip 一个 commit 不完整。
      // 改成范围化 cleanup 指引:推荐 `git reset --hard ORIG_HEAD`(干净简单 — archive_plan
      // 失败前 main repo 不会有 caller 未提交改动,destructive 风险低),保留
      // `git revert ORIG_HEAD..HEAD`(history-preserving 选项,逐 commit revert 但 caller 需
      // 处理可能的 conflict)。
      //
      // R3 MED 1 修法:选项 (2) 继续推进路径不闭合 — 旧版「on both main repo and worktree
      // branch edit」会让 caller 误编辑 main repo plan(uncommitted)→ re-call 时 step 7
      // ff-merge 撞 dirty working tree 拒绝。改成「reset → 仅在 worktree 修 → re-call(干净
      // 重跑)」让两选项都先 reset --hard ORIG_HEAD(等价 undo) 再分流(中止 / 继续)。
      //
      // R4 LOW 1 修法:revert + continue 组合 git 拓扑 — caller 选 revert range 后 main 带
      // revert commit (R1..R3),worktree 不知道 → next ff-merge 失败(main 不是 worktree
      // 祖先)。改成「revert range 仅限 abandoned 路径(选项 1 history-preserving)」+
      // 「continue 路径(选项 2)必须用 reset --hard ORIG_HEAD(reset 让 main 回到 worktree
      // 祖先,fresh ff-merge 才能成功)」。
      'main HEAD has advanced (ff-merge complete) and the plan file at the main repo has a ' +
        'status that drifted from "in_progress" on the worktree branch. ' +
        '**First step (both choices)**: undo the ff-merge in main repo with ' +
        '`git reset --hard ORIG_HEAD` (recommended — clean reset; archive_plan made no other ' +
        'main-repo changes before this failure). ' +
        'Then choose: ' +
        '(1) if caller intended abandoned: follow user CLAUDE.md §Step 4 "中止" path ' +
        '(keep status=abandoned, manual `git worktree remove --force` + `git branch -D`). ' +
        'For history-preserving abandon (audit trail), `git revert ORIG_HEAD..HEAD` instead ' +
        'of reset (per-commit revert, may need conflict resolution; only valid for option 1 — ' +
        'do NOT use revert for option 2 below: revert leaves main with new revert commits ' +
        'that diverge from worktree branch, breaking the next ff-merge); ' +
        '(2) if caller intended to continue: **must use `git reset --hard ORIG_HEAD`** ' +
        '(not revert), then edit the plan frontmatter to `status: in_progress` ' +
        '**only on the worktree branch** (cd into worktree, edit, commit; do NOT edit main repo ' +
        '— the reset already restored main to pre-archive state, and re-calling archive_plan will ' +
        'pick up the worktree-side fix via fresh ff-merge), then re-call archive_plan.',
    );
  }

  return {
    finalCommit,
    freshContent,
    freshFm: freshFm as Record<string, string>,
  };
}
