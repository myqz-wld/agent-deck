/**
 * archive-plan-impl Step 1-6 预检子模块 (plan deep-project-review-comprehensive-20260528
 * Step 4.2 拆分产物)。
 *
 * **职责**: ff-merge 之前所有 fail-fast 预检。任一条件不满足立即返结构化 error，main HEAD
 * 不动 caller 可重试。
 *
 * **业务流程** (与原 archive-plan-impl.ts:257-635 1:1 对齐, 行级精确):
 * 1. worktreePath 存在性预检 (REVIEW_33 H10) — line 272-277
 * 2. Step 1: 解析 worktree → main repo 路径 — line 279-294
 * 3. Step 2: 解析 worktree branch — line 296-308
 * 4. Step 3: 预检 worktree clean — line 310-322
 * 5. Step 3.5a: 解析 plan 文件路径 (override 或 3 档 fallback) + planFilePath stem 校验 — line 324-365
 * 6. Step 3.5b: 派生 archivedPath / indexPath + mainRepo 三具体路径 dirty precheck — line 366-414
 * 7. Step 4: cwd 4 态分流 (releaseMarkerOnSuccess) — line 416-535
 * 8. Step 5: placeholder (已挪到 step 3.5a) — line 537-540
 * 9. Step 6: 读 + parse frontmatter + status 三档分流 + planId/worktreePath cross-check — line 542-625
 * 10. Step 6.5+: worktreeBranch 命名约束 (soft warn) — line 627-634
 *
 * **跨子模块 state 流** (return value 传递,避免单一巨型 ctx object — Step 4.1 经验):
 * - mainRepo / worktreeBranch / planFilePath / fm / archivedDir / archivedPath / indexPath 给 ff-merge & archive-fs & cleanup
 * - mainRepoClean.warnings 给 cleanup commit msg 注脚
 * - releaseMarkerOnSuccess 给 cleanup 阶段 archive 完成后清 marker
 *
 * **不变量**:
 * - 任一 fail-fast 路径 main HEAD 不动 caller 可重试 (与 post-ff-merge phase 不同)
 * - warnings 数组 push 不返回 — caller 共享同一份,sub-module 直接 push
 */

import * as path from 'node:path';

import { parseFrontmatter } from '@main/utils/frontmatter';

import { resolvePlanFilePath } from '../plan-path-helpers';
import { assertMainRepoCleanForArchive } from './precheck-helpers';
import type {
  ArchivePlanInput,
  ArchivePlanDeps,
  ArchivePlanError,
  PrecheckResult,
} from './_impl-shared';

/**
 * 跑 Step 1-6 + 6.5 + worktreeBranch 命名 check。
 *
 * **Side effects** on warnings 数组(共享 ref): silent-override / branch-naming-mismatch /
 * older-plan-missing-{planId,worktreePath} / mainRepo-unrelated-dirty / cwd-marker-cross-worktree
 * (5 类预检 warning,详 ArchivePlanResult.warnings 字段 jsdoc)。
 *
 * **Return**: PrecheckResult on success / ArchivePlanError on any fail-fast。
 */
export async function runPrecheck(
  input: ArchivePlanInput,
  deps: Required<ArchivePlanDeps>,
  warnings: string[],
): Promise<PrecheckResult | ArchivePlanError> {
  // REVIEW_33 H10：worktreePath 存在性预检（放最前，所有其他预检之前）。
  // 旧实现 step 1 直接 `git rev-parse --git-common-dir` in cwd: input.worktreePath；
  // worktree 已被手工 `git worktree remove` / 跨机器迁移 / 误删时 → child_process
  // ENOENT，被 step 1 的 try/catch 抓但 error message 不清晰（混在 git rev-parse 错误
  // 里 caller 难判断到底是 worktree 不存在还是 git 真出错）。修法：先显式 deps.exists
  // 检查，缺失立即返结构化 error 提示「先建 worktree / 修正路径」。
  if (!(await deps.exists(input.worktreePath))) {
    return {
      error: `worktreePath does not exist: ${input.worktreePath}`,
      hint: `worktree may have been manually removed (\`git worktree remove\`) / cross-device synced without working tree / wrong path. Verify with \`ls -la ${input.worktreePath}\`. If you really intend to clean up the orphan branch only (no worktree dir), follow user CLAUDE.md §Step 4 manual cleanup instead of archive_plan.`,
    };
  }

  // 1. 解析 worktree → main repo 路径
  let gitCommonDir: string;
  try {
    gitCommonDir = await deps.runGit(['rev-parse', '--git-common-dir'], input.worktreePath);
  } catch (e) {
    return {
      error: `git rev-parse --git-common-dir failed in worktree: ${(e as Error).message}`,
      hint: `worktreePath "${input.worktreePath}" is not a valid git worktree (or git not installed). Verify with \`git -C ${input.worktreePath} status\`.`,
    };
  }
  // git-common-dir 在 worktree 里返回相对 / 绝对路径都可能；resolve to absolute first
  const commonDirAbs = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(input.worktreePath, gitCommonDir);
  // common-dir 是 main repo 的 `.git` 目录（或 bare repo 自身），其 dirname 即 main repo working tree
  const mainRepo = path.dirname(commonDirAbs);

  // 2. 解析 worktree branch
  let worktreeBranch: string;
  try {
    worktreeBranch = await deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], input.worktreePath);
  } catch (e) {
    return { error: `git rev-parse --abbrev-ref HEAD failed: ${(e as Error).message}` };
  }
  if (!worktreeBranch || worktreeBranch === 'HEAD') {
    return {
      error: `worktree HEAD is detached (branch=${worktreeBranch})`,
      hint: 'archive_plan requires worktree to be on a named branch so it can be ff-merged into baseBranch and then deleted.',
    };
  }

  // 3. 预检 worktree clean
  let statusOutput: string;
  try {
    statusOutput = await deps.runGit(['status', '--porcelain'], input.worktreePath);
  } catch (e) {
    return { error: `git status --porcelain failed in worktree: ${(e as Error).message}` };
  }
  if (statusOutput.length > 0) {
    return {
      error: `worktree is not clean (uncommitted changes detected)`,
      hint: `Commit or stash changes in ${input.worktreePath} before archive_plan. Status output:\n${statusOutput}`,
    };
  }

  // 3.5a. 解析 plan 文件路径（原 step 5 — plan deep-review-batch-a1-b-followup-r3-20260519
  // §Phase 1.2a 挪上去：mainRepo precheck 精确化需要知道 planFilePath/archivedPath/indexPath
  // 三个具体路径来与 git status 输出比对，所以 plan 文件路径解析必须先于 mainRepo precheck）。
  //
  // 挪过去后 step 6 plan 读 + frontmatter parse 仍用此 planFilePath（outer scope local）；
  // step 4 cwd 4 态分流不依赖 planFilePath（仅依赖 mainRepo + worktreeReal + cwdReal）；
  // step 8b 重新 read fresh plan 也走同 planFilePath 不受影响。
  let planFilePath: string;
  if (input.planFilePathOverride) {
    if (!(await deps.exists(input.planFilePathOverride))) {
      return {
        error: `planFilePath override does not exist: ${input.planFilePathOverride}`,
      };
    }
    // archive-plan-tool-ux-followup-20260515 HIGH-1 (claude 单方 + 现场验证): planFilePath
    // 文件名 stem 必须等于 planId。否则 step 10 archivedPath 用 planId 派生 = `<main-repo>
    // /ref/plans/<planId>.md` 与 caller 给的 planFilePath 文件完全脱节,step 12 因 path !==
    // archivedPath 删 caller 文件,silent unlink 风险。impl 层校验给清晰 hint(schema 是 record
    // shape 不支持 cross-field refine,故落 impl 而非 schema)。
    const overrideStem = path.basename(input.planFilePathOverride, '.md');
    if (overrideStem !== input.planId) {
      return {
        error: `planFilePath stem "${overrideStem}" does not match planId "${input.planId}"`,
        hint: `archived path / INDEX key are derived from planId (\`<main-repo>/ref/plans/${input.planId}.md\`); step 12 unlink would silently move the planFilePath file. Either rename planFilePath to \`${input.planId}.md\` or change planId to "${overrideStem}". 修法 followup 20260515 HIGH-1.`,
      };
    }
    planFilePath = input.planFilePathOverride;
  } else {
    // archive-plan-tool-ux-followup-20260515 (a) + plan deep-review-batch-a1-b-fixes-20260519
    // §Phase 3 Step 3.9 修法 (B-MED-3 双方独立强冗余):抽 resolvePlanFilePath helper 共享
    // hand-off-session-impl.ts 同款 3 档 fallback (projectLocal > projectArchived > userGlobal),
    // 顺序贴 user CLAUDE.md §Step 2 文档约定 .claude/plans/ in_progress 优先,但 ref/plans/ 中间
    // 档兜底本项目实际惯例(archive_plan 完成后 mv 目标位置)。
    const resolved = await resolvePlanFilePath(mainRepo, input.planId, {
      exists: deps.exists,
      homedir: deps.homedir,
    });
    if ('error' in resolved) {
      return resolved;
    }
    planFilePath = resolved.path;
  }
  // archivedPath / indexPath：纯路径推导（不依赖 frontmatter / git 状态），与 step 10/11
  // 计算公式 1:1 一致（archive-plan-impl.ts:648 / :694）— precheck 与 step 10/11 共享同款
  // 路径，否则会出现「precheck 检的与 step 11 实际写的不是同一文件」silent bug。
  const archivedDir = path.join(mainRepo, 'ref', 'plans');
  const archivedPath = path.join(archivedDir, `${input.planId}.md`);
  const indexPath = path.join(archivedDir, 'INDEX.md');

  // 3.5b. 预检 mainRepo 三具体路径无 dirty（plan deep-review-batch-a1-b-followup-r3-20260519
  // §不变量 5 / D3 精确化 — 不再全场 fail-fast）：lambda 内部 git status --porcelain=v1 -z
  // NUL 分隔 parser + rename R/C 类型检查 + critical path repo-relative 转换。
  //
  // **行为变化（vs B-HIGH-4 旧 fail-fast 修法）**：
  // - 旧版：mainRepo 任意 dirty → 全部 reject + hint 让 caller 先 commit/stash
  // - 新版：只 reject 三具体路径 {archivedPath, indexPath, planFilePath} 的 dirty + rename
  //   的 old/new path 任一命中也 reject；其他 dirty 文件降 warning，commit 阶段后面会用
  //   pathspec 隔离（Phase 4.1）只 commit 三个归档路径不吞无关 staged。
  const mainRepoClean = await assertMainRepoCleanForArchive(
    { runGit: deps.runGit },
    { mainRepoAbsPath: mainRepo, archivedPath, indexPath, planFilePath },
  );
  if (!mainRepoClean.ok) {
    const conflictLines = mainRepoClean.conflicts
      .map((c) => `  ${c.status} ${c.path}`)
      .slice(0, 10)
      .join('\n');
    return {
      error: `main repo ${mainRepo} has uncommitted changes on archive-critical paths (${mainRepoClean.conflicts.length} conflict${mainRepoClean.conflicts.length === 1 ? '' : 's'}); archive_plan refuses to overwrite.`,
      hint:
        `Critical paths checked: ${path.relative(mainRepo, archivedPath)} / ${path.relative(mainRepo, indexPath)} / ${path.relative(mainRepo, planFilePath)}. ` +
        `Detected conflicts:\n${conflictLines}${mainRepoClean.conflicts.length > 10 ? '\n  (... more)' : ''}\n` +
        `Please commit / stash / git restore these specific paths first, then retry archive_plan. ` +
        `(plan deep-review-batch-a1-b-followup-r3-20260519 §不变量 5 精确化：不再因无关 dirty 而 reject，但 ` +
        `archive-critical paths 仍 fail-fast 避免 silent overwrite。)\n\n` +
        `F1b 软引导（plan §D4 真根因防绕过）: 不建议手工 commit + mv 绕过 archive_plan tool — ` +
        `会让 baton-cleanup phase 1 teammate shutdown 没被调到，导致 reviewer 自然衰减成 dormant 残留 ` +
        `（R3 实证「6 reviewer dormant 未 closed」即此场景）。优先 fix 上述 conflicts 后重 invoke archive_plan tool；` +
        `若必须手工归档（conflicts 无法立即修），手工 commit + mv 后调 mcp__agent-deck__shutdown_baton_teammates tool ` +
        `补跑 baton-cleanup phase 1（其参数 { callerSessionId, planId? }，单独 shutdown 同 team active+dormant teammate ` +
        `+ 写 team_member.left_at 软退出，不归档 caller — escape hatch 仅供本场景 fallback 使用，user CLAUDE.md §Step 4 ` +
        `5 步手工归档仍是合法 fallback）。`,
    };
  }
  // mainRepoClean.warnings 透传 caller 让 Phase 4.1 commit message 后续可加注脚（暂不在
  // ok return 中暴露 — warnings 数组已是 result 字段但来自 silent-override 等 step 10 路径，
  // 本层 dirty warning 在 commit 阶段决定如何呈现）。
  if (mainRepoClean.warnings.length > 0) {
    warnings.push(
      `main-repo-unrelated-dirty: ${mainRepoClean.warnings.length} unrelated dirty file${mainRepoClean.warnings.length === 1 ? '' : 's'} in main repo (not on archive-critical paths). archive_plan will commit only archive-critical pathspec (Phase 4.1) so these files remain dirty post-archive but not mixed into the archive commit. Sample: ${mainRepoClean.warnings.slice(0, 3).map((w) => `${w.status} ${w.path}`).join(', ')}${mainRepoClean.warnings.length > 3 ? '...' : ''}.`,
    );
  }

  // 4. 预检 cwd 4 态分流（plan codex-handoff-team-alignment-20260518 P1 Step 1.4 / 不变量 5 + D2）
  //
  // **P5 Round 1 reviewer-codex HIGH-1 修法 (cwd valid/invalid 4 态分流完整实现)**：
  // 旧 impl 用 `inWorktree × marker` 4 态,但 plan §不变量 5 是 `cwd valid/invalid` 4 态。
  // 旧 impl realpath(callerCwd) 失败直接 return error,从未读 marker → 不变量 5 (b)
  // "cwd invalid + marker==worktreeReal → release marker 预检通过"完全没实现,违反 P1 phase
  // 解锁 HIGH-C 根本目的(codex teammate worktree 被外部 git worktree remove 后还能 archive_plan)。
  //
  // **新分流（plan §不变量 5 4 态 + cwd-valid 子分流细化）**：
  // - cwd valid + !inWorktree + marker null      → 状态 (a):  放过 (claude builtin caller, 已 ExitWorktree)
  // - cwd valid + inWorktree  + marker==worktree → 放过 + release (codex caller with marker)
  // - cwd valid + inWorktree  + marker null      → reject (claude builtin caller, 忘 ExitWorktree)
  // - cwd valid + inWorktree  + marker!=worktree → reject (cross-worktree)
  // - cwd valid + !inWorktree + marker present   → 状态 (c):  warning + 放过 + release (caller 移走 cwd 但忘 exit_worktree)
  // - cwd invalid + marker==worktree             → 状态 (b):  放过 + release (worktree 已被外部 git worktree remove,marker 兜底)
  // - cwd invalid + marker null                  → 状态 (d):  reject (cwd resilience guard rail,session state 丢失)
  // - cwd invalid + marker present + !=worktree  → 状态 (d):  reject (cwd 失效 + marker 指其他 worktree,confused state)
  //
  // **release marker 时序**：releaseMarkerOnSuccess flag 标记需在 archive 完整成功后调
  // deps.clearCwdReleaseMarker(),否则 archive 中途失败 marker 残留让 caller 可重试。
  const callerCwd = deps.cwd();
  let cwdReal: string | null = null;
  let cwdValid = true;
  try {
    cwdReal = await deps.realpath(callerCwd);
  } catch {
    cwdValid = false;
  }
  // worktreeReal 走单独 try/catch — 这里失败是真错（line 179 deps.exists 已确认 worktree 存在,
  // realpath 仍失败说明 permission / I/O 异常,与 callerCwd 失效语义不同）
  let worktreeReal: string;
  try {
    worktreeReal = await deps.realpath(input.worktreePath);
  } catch (e) {
    return { error: `realpath of worktreePath failed: ${(e as Error).message}` };
  }
  const marker = deps.cwdReleaseMarker();
  // marker 也走 realpath 解 symlink 与 worktreeReal 对齐（防 caller marker 写绝对路径但
  // 与 worktreeReal symlink 化解析结果不字面相等导致 false negative）。realpath 失败 fallback
  // 原 marker（不抛），与 cwd 失败处理对齐 — 极端 edge case 退化为字面比较。
  let markerReal: string | null = marker;
  if (marker) {
    try {
      markerReal = await deps.realpath(marker);
    } catch {
      markerReal = marker;
    }
  }

  let releaseMarkerOnSuccess = false;

  if (cwdValid && cwdReal) {
    // worktree 子树检测：cwdReal 必须 startWith worktreeReal + sep（或精确等于）
    const inWorktree =
      cwdReal === worktreeReal || cwdReal.startsWith(worktreeReal + path.sep);
    if (inWorktree) {
      if (markerReal === worktreeReal) {
        // cwd valid + inWorktree + marker==worktree: 放过 (codex caller 持 mcp enter_worktree marker)
        // archive 完成后 release marker（caller 调 archive 后 marker 已无意义,清掉避免下次复用 stale）
        releaseMarkerOnSuccess = true;
      } else if (markerReal === null) {
        // 状态 3 (旧编号): reject (走 claude builtin 路径但忘 ExitWorktree)
        return {
          error: `caller cwd ${cwdReal} is inside the worktree ${worktreeReal} but no enter_worktree marker held`,
          hint: 'mcp tool cannot call ExitWorktree (Claude CLI internal tool). For claude SDK session caller, ExitWorktree first then call archive_plan. For codex / cross-adapter caller, use mcp enter_worktree to acquire the marker before this archive_plan call.',
        };
      } else {
        // 状态 4 (旧编号): reject (marker 指向另一个 worktree)
        return {
          error: `caller cwd inside worktree ${worktreeReal} but holds marker for a different worktree (${markerReal})`,
          hint: `Cross-worktree archive is not allowed. Either call exit_worktree on the marker's worktree first (to clear the stale marker), or call archive_plan with worktreePath matching the held marker (${markerReal}).`,
        };
      }
    } else {
      // cwd valid + !inWorktree
      // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.7 修法 (B-MED-1 claude):
      // 旧版 `if (markerReal !== null)` 一档全部 release marker — markerReal 指向另一 worktree
      // 时也错误 release,silent 偷 cross-worktree caller 状态。拆 3 子档:
      // (c-1) marker == worktree → 可 release(caller 持本 worktree marker 但 cd 出去)
      // (c-2) marker 指向另一 worktree → 仅 warn 不 release(let caller exit_worktree 自己清)
      // (c-3) marker null → 直接放过(claude builtin caller 已 ExitWorktree,现有路径不变)
      if (markerReal === worktreeReal) {
        // 状态 (c-1) plan §不变量 5: cwd valid + marker == worktreeReal → WARN + release
        // caller 持本 worktree marker 但 cd 出去,典型 claude SDK ExitWorktree(action:keep)
        // 之前用 mcp enter_worktree 进过,现在改用 builtin ExitWorktree 但 marker 还在。
        warnings.push(
          `cwd ${cwdReal} is outside worktree but enter_worktree marker (${markerReal}) is held — caller likely forgot exit_worktree before changing cwd. Marker will be released after archive succeeds.`,
        );
        releaseMarkerOnSuccess = true;
      } else if (markerReal !== null) {
        // 状态 (c-2) plan §不变量 5: cwd valid + marker 指向另一 worktree → 仅 WARN 不 release。
        // 不可 release 别人的 worktree marker — 让 caller 自己 exit_worktree(markerReal) 清。
        // archive 本身仍走 happy path(不阻塞 cross-worktree archive,本字段语义只是 release marker)。
        warnings.push(
          `cwd ${cwdReal} is outside worktree, but caller holds marker for a different worktree (${markerReal}). Archive(${worktreeReal}) will not release marker(${markerReal}); caller should call exit_worktree on ${markerReal} separately.`,
        );
        // 不设 releaseMarkerOnSuccess: 不允许跨 worktree release 别人 marker
      }
      // 状态 (c-3) plan §不变量 5: cwd valid + marker null + !inWorktree → 直接放过 (claude
      // builtin caller 已 ExitWorktree, 现有路径不变)。
    }
  } else {
    // cwdValid === false: caller cwd 失效（目录被删 / permission error / 跨 adapter 后 cwd resilience 移除）
    if (markerReal === worktreeReal) {
      // 状态 (b) plan §不变量 5: cwd invalid + marker==worktreeReal → release marker, 预检通过。
      // 典型场景: codex teammate enter_worktree 持 marker → 外部 git worktree remove --force →
      // cwd 失效但 marker 仍指向被删的 worktree。允许 archive_plan 走完归档动作（git ops 走 mainRepo
      // 不依赖 callerCwd），并清 marker 避免 session 重启后 stale。
      releaseMarkerOnSuccess = true;
    } else {
      // 状态 (d) plan §不变量 5: cwd invalid + marker null OR marker 不匹配 worktree → ERROR
      // (cwd resilience guard rail: caller session state 丢失/混乱)
      return {
        error: `caller cwd ${callerCwd} is invalid (realpath failed)${markerReal ? ` and marker (${markerReal}) does not match worktreePath (${worktreeReal})` : ' and no enter_worktree marker held'}`,
        hint: markerReal
          ? `cwd resilience guard rail: caller cwd was deleted/moved while a stale marker for a different worktree remains. Either call exit_worktree({ worktreePath: '${markerReal}' }) on the held worktree first to clear the stale marker, or call archive_plan with worktreePath matching the marker.`
          : `cwd resilience guard rail: caller cwd was deleted/moved without an enter_worktree marker fallback. Restart the caller session in a valid working directory before retrying archive_plan, or pass a fresh callerSessionId whose sessionRepo.cwd is valid.`,
      };
    }
  }

  // 5. 解析 plan 文件路径 — **已挪到 step 3.5a**（plan deep-review-batch-a1-b-followup-r3
  // -20260519 §Phase 1.2a）。`planFilePath` 在 outer scope 已被 step 3.5a 赋值（含
  // planFilePathOverride 校验 + 3 档 fallback resolvePlanFilePath），此处保留 step 5
  // 编号 placeholder 以保持下游编号连续；step 6 仍可直接用 outer scope 的 planFilePath。

  // 6. 读 + parse frontmatter，预检 status
  let planContent: string;
  try {
    planContent = await deps.readFile(planFilePath);
  } catch (e) {
    return { error: `read plan file failed: ${(e as Error).message}` };
  }
  const fm = parseFrontmatter(planContent);
  if (Object.keys(fm).length === 0) {
    return {
      error: `plan file has no parseable frontmatter: ${planFilePath}`,
      hint: 'plan file must start with `---\\n<key>: <value>\\n---\\n` block.',
    };
  }
  // REVIEW_33 H2：旧实现只 reject `completed`，让 `abandoned` / unknown 走完归档流程。
  // 后果：abandoned plan 会被 ff-merge 到 main + 写入 ref/plans/ git 历史（违反 user CLAUDE.md
  // §Step 4 abandoned cleanup —— abandoned 应走 `git worktree remove --force` 静默销毁
  // 而非入项目 git）。修法：三档 status 显式分流，仅 in_progress 放行。
  if (fm.status === 'completed') {
    return {
      error: `plan status is already "completed"`,
      hint: `archive_plan refuses re-archive (defensive). If you really need to re-run, manually edit frontmatter status back to in_progress.`,
    };
  }
  // Phase A4 / R1 deep review MED-3 + REVIEW_33 H2 共识：abandoned plan 不应走
  // archive_plan（user CLAUDE.md §Step 4 中止流程明示）。历史只拒 completed → abandoned
  // 会被静默继续 merge/mv/commit 把废弃 plan 当成完成的归档进项目 git，与文档语义反向。
  if (fm.status === 'abandoned') {
    return {
      error: `plan status is "abandoned" — abandoned plans must not be archived as completed`,
      hint: `archive_plan only handles in_progress → completed transitions. For abandoned plans follow user CLAUDE.md §Step 4 \"中止\" path: keep frontmatter status=abandoned, ExitWorktree(action: keep), then manual \`git worktree remove --force\` + \`git branch -D\`. Don't move plan into <main-repo>/ref/plans/.`,
    };
  }
  if (fm.status !== 'in_progress') {
    return {
      error: `plan status must be "in_progress" but got "${fm.status ?? '<missing>'}"`,
      hint: `Edit ${planFilePath} frontmatter to set \`status: in_progress\` before calling archive_plan, or use a status value matching the documented lifecycle (in_progress / completed / abandoned).`,
    };
  }

  // 6.5. CHANGELOG_169 F2 [HIGH]: frontmatter ↔ input cross-check (plan_id / worktree_path binding)
  //
  // reviewer-codex finding（双方反驳轮裁决 HIGH 真问题）：caller 误传另一 plan 的 worktreePath 时，
  // 之前的代码不校验 fm.worktree_path / fm.plan_id 与输入一致 → silent corruption（plan-A 错标
  // completed + plan-B worktree 被删 + ff-merge 合错 commit + plan-B 工作整片丢失）。典型触发：
  // user 跑 2-3 plan 收尾时 tab-complete 撞同名 dir / 复制粘贴撞错路径。
  //
  // **D7 决策**（向后兼容老 plan）：字段存在严格校验,字段缺失 soft warn 不 reject。新 plan 模板
  // 已含 plan_id / worktree_path frontmatter（详 resources/claude-config/CLAUDE.md §Step 1
  // plan 内容文档），老 plan 没字段时不破坏归档。
  //
  // REVIEW_68 batch-3 [HIGH]: plan frontmatter 是 snake_case（CHANGELOG_177 列为合法保留，不随
  // mcp arg 一起迁 camelCase）。camelcase migration（commit 5ff0d78）误把这里读成 fm.planId /
  // fm.worktreePath → snake-only plan（文档约定 + 所有归档 plan 实际写法）两个字段恒缺失 → 静默
  // 走「skipping cross-check」warning 分支 → 本 HIGH silent-corruption 守门实际失效。读 snake_case
  // key 回正（input.* 仍是 camelCase mcp arg，不动）。
  if (typeof fm.plan_id === 'string' && fm.plan_id !== input.planId) {
    return {
      error: `plan_id mismatch: frontmatter plan_id="${fm.plan_id}" but archive_plan called with planId="${input.planId}"`,
      hint: `Caller likely passed wrong worktreePath for this planId (or vice versa). Refusing to ff-merge / write / unlink to avoid silent corruption (the wrong-binding case would merge another worktree's branch + delete another worktree + mark this plan completed). Verify with \`head -10 ${planFilePath}\` then call archive_plan with matching planId + worktreePath pair.`,
    };
  } else if (typeof fm.plan_id !== 'string') {
    warnings.push(
      `plan frontmatter has no plan_id field — skipping plan_id cross-check (older plan; new plan template includes this field per resources/claude-config/CLAUDE.md §Step 1)`,
    );
  }

  if (typeof fm.worktree_path === 'string' && fm.worktree_path) {
    let fmWtReal: string;
    let inputWtReal: string;
    try {
      fmWtReal = await deps.realpath(fm.worktree_path);
      inputWtReal = await deps.realpath(input.worktreePath);
    } catch (e) {
      return {
        error: `realpath check failed during worktree_path cross-check: ${(e as Error).message}`,
        hint: `Either fm.worktree_path="${fm.worktree_path}" or input.worktreePath="${input.worktreePath}" cannot be realpath-resolved (likely a broken symlink or already removed). Fix fs state before retrying.`,
      };
    }
    if (fmWtReal !== inputWtReal) {
      return {
        error: `worktree_path mismatch: frontmatter worktree_path="${fm.worktree_path}" (realpath="${fmWtReal}") but archive_plan called with worktreePath="${input.worktreePath}" (realpath="${inputWtReal}")`,
        hint: `Caller likely passed wrong worktreePath for this planId. Refusing to ff-merge / write / unlink to avoid silent corruption (the wrong-binding case would merge another worktree's branch + delete another worktree + mark this plan completed). Verify plan frontmatter or correct args.worktreePath.`,
      };
    }
  } else {
    warnings.push(
      `plan frontmatter has no worktree_path field — skipping worktree_path cross-check (older plan; new plan template includes this field per resources/claude-config/CLAUDE.md §Step 1)`,
    );
  }

  // 可选第三道防御:branch 命名约束(soft warn 而非硬 reject — 老 plan 用户自建 worktree
  // 时 branch 名可能不符 enter_worktree 约定 `worktree-<planId>`,允许通过但提示不一致)。
  const expectedBranch = `worktree-${input.planId}`;
  if (worktreeBranch !== expectedBranch) {
    warnings.push(
      `worktree branch name "${worktreeBranch}" does not match enter_worktree convention "${expectedBranch}" — accepting (caller manually created worktree), but cross-plan binding errors won't be caught by branch naming alone`,
    );
  }

  return {
    mainRepo,
    worktreeBranch,
    planFilePath,
    fm: fm as Record<string, string>,
    archivedDir,
    archivedPath,
    indexPath,
    mainRepoClean: { warnings: mainRepoClean.warnings },
    releaseMarkerOnSuccess,
  };
}
