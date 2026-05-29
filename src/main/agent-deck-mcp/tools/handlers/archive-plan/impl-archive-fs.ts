/**
 * archive-plan-impl Step 9-12.5 archive-fs 子模块 (plan deep-project-review-comprehensive-20260528
 * Step 4.2 拆分产物)。
 *
 * **职责**: ff-merge 通过后,把 plan 文件实际归档到 `<main-repo>/ref/plans/<id>.md`,同步
 * INDEX.md,删除原 plan,归档 spike-reports/ 子目录(如有)。所有 fs writeFile / mkdir / mvDir
 * 操作。任一步失败走 postFfMergeErr,caller 需按 phase hint 手工补完后续 (不能整体 retry)。
 *
 * **业务流程** (与原 archive-plan-impl.ts:800-988 1:1 对齐):
 * 1. Step 9: 更新 frontmatter (newFm 派生,用 freshFm 而非预检 fm) — line 800-808
 * 2. Step 10: 写新 plan 到 archivedPath (含 silent-override 检测 → push warning) — line 810-852
 * 3. Step 11: 同步 INDEX.md (走 indexSyncFlight 单飞锁防 caller 并发 RMW race) — line 854-917
 * 4. Step 12: 删除原 plan 文件 (如果原位置不在新位置即 mv 完成) — line 919-932
 * 5. Step 12.5: spike-reports/ 归档 (detect → mv → rmdir empty parent → warning on failure) — line 934-988
 *
 * **不变量**:
 * - **post-ff-merge 写入路径**: Step 9 / 10 / 11 writeFile 全部用 freshFm + freshContent
 *   (与 _impl-shared.ts §PostFfMergePhase jsdoc 一致),严禁回到 precheck fm
 * - Step 11 INDEX 同步走 indexSyncFlight 单飞 (in-process 防 caller 并发 RMW race)
 * - Step 12.5 spike-reports mv 失败 → warning 不阻塞 ok return,caller 看 hint 手工 mv
 */

import * as path from 'node:path';

import { stringifyFrontmatter } from '@main/utils/frontmatter';

import {
  escapeTableCell,
  formatChangelogCell,
  syncPlansIndex,
} from './index-sync-helpers';
import {
  formatLocalDate,
  indexSyncFlight,
  postFfMergeErr,
  stripFrontmatter,
} from './_impl-shared';
import type {
  ArchiveFsResult,
  ArchivePlanDeps,
  ArchivePlanError,
  ArchivePlanInput,
  ArchivePlanResult,
} from './_impl-shared';

/**
 * Step 9-12.5 archive-fs 主体。
 *
 * **Input ctx** from runPrecheck + runFfMerge return:
 *   - mainRepo / planFilePath / archivedDir / archivedPath / indexPath (path 派生 — precheck 输出)
 *   - freshFm / freshContent / finalCommit (post-ff-merge state — ff-merge 输出)
 *
 * **Side effects** on warnings 数组(共享 ref):
 *   - silent-override (Step 10 同 plan_id 双存)
 *   - spike-reports rmdir parent failed (Step 12.5 sibling artifacts 残留)
 *   - spike-reports mv failed (Step 12.5 EXDEV / perm)
 *
 * **Return**: ArchiveFsResult { plansIndexAction, spikeReportsArchived } / ArchivePlanError on fail。
 */
export async function runArchiveFs(
  input: ArchivePlanInput,
  deps: Required<ArchivePlanDeps>,
  warnings: string[],
  ctx: {
    mainRepo: string;
    planFilePath: string;
    archivedDir: string;
    archivedPath: string;
    indexPath: string;
    freshFm: Record<string, string>;
    freshContent: string;
    finalCommit: string;
  },
): Promise<ArchiveFsResult | ArchivePlanError> {
  const {
    mainRepo,
    planFilePath,
    archivedDir,
    archivedPath,
    indexPath,
    freshFm,
    freshContent,
    finalCommit,
  } = ctx;

  // 9. 更新 frontmatter(用 freshFm,而非 step 6 的 fm — 让 caller 在 worktree branch
  // commit 的任意 fm 字段变更也透传到归档 plan)
  const today = formatLocalDate(new Date());
  const newFm: Record<string, string> = {
    ...freshFm,
    status: 'completed',
    final_commit: finalCommit,
    completed_at: today,
  };

  // 10. 写新 plan(body 用 freshContent — 保留 caller 在 worktree branch 的 [x] checklist
  // / 跳过理由 / 当前进度 等收尾回写)
  // archivedDir / archivedPath 已在 step 3.5a 计算（Phase 1.2a 提前路径算法）— 此处复用。
  // archive-plan-tool-ux-followup-20260515 HIGH-2 (双方独立 HIGH 共识) silent override warn:
  // 同 plan_id 同时存在 `.claude/plans/<id>.md` AND `<main-repo>/ref/plans/<id>.md`(caller 误操作 /
  // 历史遗留)→ fallback 链选 .claude/plans/ 后 step 10 静默覆盖 ref/plans/ 历史 completed archive。
  // 用户决策(Q1):走 warn 而非 reject(不阻断 archive,只让 caller 看到风险)。
  if (path.resolve(planFilePath) !== path.resolve(archivedPath)) {
    if (await deps.exists(archivedPath)) {
      warnings.push(
        `silent-override: plan_id "${input.planId}" exists at both source ${planFilePath} and archived target ${archivedPath}. ` +
          `Step 10 will overwrite ${archivedPath} (历史 completed archive 可能被覆盖)。建议 caller 后续手工 reconcile:` +
          `(1) inspect git log ${path.relative(mainRepo, archivedPath)} 看老归档历史;` +
          `(2) 决定保留哪份(典型: 老归档 + 本次 fix 用 git revert 回滚或 merge);` +
          `(3) rm 多余的 ${planFilePath} 防再次撞同款 warning。`,
      );
    }
  }
  try {
    await deps.mkdir(archivedDir);
  } catch (e) {
    return postFfMergeErr(
      'mkdir-plans-dir',
      e as Error,
      `mkdir -p ${archivedDir} failed (disk full / perm denied / path conflict). ` +
        `Fix fs state then manually \`mkdir -p ${archivedDir}\` (idempotent — this single step is retry-safe); ` +
        `complete steps 10b-14 manually (write archived plan / sync INDEX / unlink original / git add+commit / worktree remove / branch -D). ` +
        `Cannot retry archive_plan as a whole (would hit "branch already merged" on ff-merge).`,
    );
  }
  const body = stripFrontmatter(freshContent);
  const newContent = `${stringifyFrontmatter(newFm)}\n${body}`;
  try {
    await deps.writeFile(archivedPath, newContent);
  } catch (e) {
    return postFfMergeErr(
      'write-archived-plan',
      e as Error,
      `Writing archived plan to ${archivedPath} failed (disk full / perm denied / fs lock). ` +
        `Fix fs state then manually write the same content to ${archivedPath} (frontmatter: status=completed + final_commit=${finalCommit} + completed_at=${today}, body = original plan body from ${planFilePath}); ` +
        `complete steps 11-14 manually (sync INDEX / unlink original / git add+commit / worktree remove / branch -D).`,
    );
  }

  // 11. 同步 ref/plans/INDEX.md(archive-plan-tool-ux-followup-20260515 (b)+(c) syncPlansIndex helper
  // 重写):4 列 canonical 格式 `| 文件 | 状态 | 关联 changelog | 概要 |`,smart update existing
  // 行(替换 status / changelog / description 列),caller 不传 changelog_id 时保留老 4 列 changelog
  // 列 / 旧 2 列 row 或新 append 用 `—` placeholder。description / changelog 列 escape `|` + 换行。
  // indexPath 已在 step 3.5a 计算（Phase 1.2a 提前路径算法）— 此处复用。
  // freshFm 而非 step 6 fm — 与 step 9-10 frontmatter / body 写入保持同源
  const rawSummary = (freshFm.description ?? freshFm.plan_id ?? input.planId).slice(0, 200);
  const summary = escapeTableCell(rawSummary);
  const changelogCell = formatChangelogCell(input.changelogId);
  let plansIndexAction: ArchivePlanResult['plansIndexAction'];
  try {
    // CHANGELOG_169 F6: 单飞锁包 INDEX RMW。同 indexPath 并发 archive 严格串行,先到先得。
    // try/catch/finally delete Map 保证异常路径也释放(参考 recoverer.ts 同款 pattern)。
    // 用 IIFE 把 RMW 包成 async function 让 promise 自身有 await 路径,避免 unhandled rejection。
    const previousFlight = indexSyncFlight.get(indexPath);
    if (previousFlight) {
      try {
        await previousFlight;
      } catch {
        /* 上一轮 archive 的 INDEX RMW 失败不影响本轮 — 本轮按 fresh state RMW */
      }
    }
    const flightPromise: Promise<ArchivePlanResult['plansIndexAction']> = (async () => {
      const indexExists = await deps.exists(indexPath);
      const existingContent = indexExists ? await deps.readFile(indexPath) : null;
      const syncResult = syncPlansIndex(existingContent, {
        planId: input.planId,
        description: summary,
        changelogCell,
      });
      if (syncResult.action !== 'unchanged') {
        await deps.writeFile(indexPath, syncResult.newContent);
      }
      return syncResult.action;
    })();
    indexSyncFlight.set(
      indexPath,
      // .then(success, failure) 让 Map 里的 promise 自身永远 resolve(不抛 unhandled rejection),
      // 同时实际的 rejection 由 await flightPromise 路径处理(下面 try/catch)。
      flightPromise.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      plansIndexAction = await flightPromise;
    } finally {
      // delete Map 让下个 caller 可以拿新锁,即使本 caller throw 也清干净
      const stored = indexSyncFlight.get(indexPath);
      if (stored !== undefined) {
        // best-effort:仅删自己设的那把锁(防多 caller 交错下误删别人的锁)。
        // 由于 await 完成后必定释放本次 IIFE 衍生的 .then() promise,直接 delete 即可。
        indexSyncFlight.delete(indexPath);
      }
    }
  } catch (e) {
    return postFfMergeErr(
      'sync-plans-INDEX',
      e as Error,
      `Writing ${indexPath} failed (rare race / fs perm). ` +
        `Fix fs state then manually append a 4-column row \`| [${input.planId}.md](${input.planId}.md) | completed | <changelog ref or "—"> | <description> |\` to the INDEX table at ${indexPath} (header should be \`| 文件 | 状态 | 关联 changelog | 概要 |\`); ` +
        `complete steps 12-14 manually (unlink original / git add+commit / worktree remove / branch -D).`,
    );
  }

  // 12. 删除原 plan 文件（如果原位置不在新位置）
  if (path.resolve(planFilePath) !== path.resolve(archivedPath)) {
    try {
      await deps.unlink(planFilePath);
    } catch (e) {
      return postFfMergeErr(
        'unlink-original-plan',
        e as Error,
        `rm ${planFilePath} failed (perm denied / file already removed by external / mv to elsewhere). ` +
          `Fix fs state then manually \`rm ${planFilePath}\` (or skip if file is already gone — that's the desired end state); ` +
          `complete steps 13-14 manually (git add+commit / worktree remove / branch -D).`,
      );
    }
  }

  // 12.5. spike-reports/ 归档 (plan deep-review-batch-a1-b-followup-r3-20260519 follow-up):
  //
  // **背景**: user CLAUDE.md §Step 0.5 spike 节约定 spike artifacts 落 `<plan-artifact-dir>/spike-reports/`
  // (典型: `<main-repo>/.claude/plans/<plan-id>/spike-reports/`)。旧 archive_plan tool 只 mv plan
  // .md 不动 spike-reports/ 导致 artifacts 留 .claude/plans/ (.gitignore 不入 git) → 永久丢失。
  //
  // **修法**: detect `<plan-artifact-dir>/spike-reports/` 存在 → mv 到
  // `<main-repo>/ref/plans/<plan-id>/spike-reports/` (plan .md 同名子目录,与 plan .md 平级),
  // push 路径到 filesToAdd 入归档 commit。失败 (EXDEV 跨 fs / perm) → warning + 不阻塞 ok return。
  //
  // **不存在时**: skip 不报错 (plan 没 spike 是合法场景,如 trivial plan / spike 阶段被跳过)。
  const srcSpikeDir = path.join(path.dirname(planFilePath), input.planId, 'spike-reports');
  const dstSpikeDir = path.join(mainRepo, 'ref', 'plans', input.planId, 'spike-reports');
  let spikeReportsArchived: { srcPath: string; dstPath: string } | null = null;
  // CHANGELOG_169 F8 [MED]: srcSpikeDir == dstSpikeDir 边界 guard(reviewer-claude finding)。
  // plan_file_path 已在 `<main-repo>/ref/plans/<plan-id>.md` 时(典型本项目 30+ stub plan 场景),
  // path.dirname(planFilePath) === `<main-repo>/ref/plans` → srcSpikeDir 与 dstSpikeDir 完全相等。
  // 老 impl 走 mv same → no-op + rmdir parent 非空 fail swallow,但 spikeReportsArchived 仍设
  // non-null 误导 caller 以为归档了。修法:加 path.resolve 比较 guard,相等 skip + 保 null 语义。
  // 复用 step 12 (line 902) 同款 path.resolve guard 模式。
  if (
    (await deps.exists(srcSpikeDir)) &&
    path.resolve(srcSpikeDir) !== path.resolve(dstSpikeDir)
  ) {
    try {
      // mkdir parent dir (`<main-repo>/ref/plans/<plan-id>/`) for dstSpikeDir
      await deps.mkdir(path.dirname(dstSpikeDir));
      await deps.mvDir(srcSpikeDir, dstSpikeDir);
      spikeReportsArchived = { srcPath: srcSpikeDir, dstPath: dstSpikeDir };
      // 顺手清空 `<plan-artifact-dir>/` 空目录 (mv 后空目录残留)
      //
      // CHANGELOG_169 F7 [MED] 修法 (reviewer-claude finding): rmdir 失败时 push 到 warnings
      // 让 caller 知情(不再 swallow)。典型场景:plan-artifact-dir 含 sibling artifacts(runner.mjs /
      // case-A.log 等不在 spike-reports/ 子目录的 plan-side 文件) → rmdir 因目录非空 fail →
      // 老 impl 静默 swallow 让 caller 误以为归档完整,实际 sibling 残留在原 worktree 父目录。
      const planArtifactDir = path.join(path.dirname(planFilePath), input.planId);
      try {
        await deps.rmdir(planArtifactDir);
      } catch (e) {
        warnings.push(
          `spike-reports parent dir not empty after mv: rmdir "${planArtifactDir}" failed (${(e as Error).message}). ` +
            `Sibling artifacts (e.g. runner.mjs / case-A.log not in spike-reports/) remain in source dir, NOT included in archive commit. ` +
            `Manually inspect with \`ls "${planArtifactDir}"\` and either move siblings into ref/plans/<plan-id>/ to include in archive, or delete them.`,
        );
      }
    } catch (e) {
      // mv 失败 (典型 EXDEV 跨 fs / perm denied) → warning + 不阻塞 ok return
      warnings.push(
        `spike-reports archive failed: mv "${srcSpikeDir}" → "${dstSpikeDir}" threw ${(e as Error).message}. ` +
          `Plan .md already archived to ${archivedPath} but spike-reports/ still at source. ` +
          `Manually run \`mkdir -p ${path.dirname(dstSpikeDir)} && mv "${srcSpikeDir}" "${dstSpikeDir}"\` ` +
          `then \`git add ${path.relative(mainRepo, dstSpikeDir)} && git commit --amend --no-edit\` to include spike-reports/ in archive commit.`,
      );
    }
  }

  return {
    plansIndexAction,
    spikeReportsArchived,
  };
}
