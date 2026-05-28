/**
 * archive_plan handler 的实现层 — git / fs / frontmatter 业务逻辑（plan
 * mcp-bug-and-feature-batch-20260513 Phase 4a Step 4a.2）。
 *
 * **抽出 impl 子模块的动机**：handler 入口（archive-plan.ts）只做 deny external + caller
 * 反查 + 调本 impl + 包 ok/err。git / fs / frontmatter 的业务行为在这里，可以单测时
 * inject deps mock 走纯 in-memory，不需要 vi.mock node 内置（更干净）。
 *
 * **业务流程**（user CLAUDE.md §Step 4 cleanup 的 5 步 Bash 1:1 自动化）：
 *
 * 1. 解析 worktree → main repo 路径：`git -C <worktree> rev-parse --git-common-dir`
 *    拿 main `.git` 共同目录的绝对路径（worktree 共享主仓库 .git），dirname 即 main repo
 * 2. 解析 worktree 当前 branch：`git -C <worktree> rev-parse --abbrev-ref HEAD`
 * 3. 预检 worktree 是 clean 的：`git -C <worktree> status --porcelain` 输出空
 * 4. 预检 process.cwd() **不在** worktree 内（用 realpath 解 symlink + startsWith
 *    主从关系判定）—— mcp tool 不能调 ExitWorktree（CLI 内部 tool），caller 必须先 ExitWorktree
 *    再调 archive_plan
 * 5. 解析 plan 文件路径（显式给 > <main-repo>/.claude/plans/<id>.md > <main-repo>/ref/plans/<id>.md > ~/.claude/plans/<id>.md）
 * 6. 读 plan + parseFrontmatter，预检 status：仅 in_progress 放行；completed 拒绝防误调；
 *    abandoned 拒绝并指向 user CLAUDE.md §Step 4 「中止」流程（REVIEW_33 H2）
 * 7. fast-forward merge：在 main repo 跑 `git merge --ff-only <worktree-branch>`
 * 8. 拿最终 commit hash：`git -C <main-repo> rev-parse HEAD`
 * 8b. **重新 read plan + parse fresh frontmatter**（plan archive-plan-content-overwritten
 *     -fix-20260515）：ff-merge 后 main working tree 已含 caller 在 worktree branch 的最后
 *     一笔 plan 回写（[x] checklist / 跳过理由 / 当前进度 等）。step 6 的 fm 已用完，下面
 *     step 9 / step 10 / step 11 全部用 freshFm + freshContent，避免覆盖 caller 收尾回写。
 * 8c. **重新校验 freshFm.status === 'in_progress'**（plan archive-plan-content-overwritten
 *     -fix-20260515 R1 review HIGH-B）：caller 若在 worktree branch commit 把 status 改
 *     abandoned/completed/未知值，ff-merge 把改动带进 main → 必须 postFfMergeErr 拒绝，否则
 *     step 9 spread 后 `status: 'completed'` 强制覆盖会静默归档 abandoned plan 为 completed,
 *     违反 user CLAUDE.md §Step 4 「中止」契约 + 回归 REVIEW_33 H2 已修过的 abandoned 防线。
 * 9. 更新 frontmatter：status=completed / final_commit / completed_at（YYYY-MM-DD 本地时区）
 * 10. 写新 plan 到 `<main-repo>/ref/plans/<plan_id>.md`（recursive mkdir <main>/ref/plans/）
 * 11. 同步 `<main-repo>/ref/plans/INDEX.md`：append 一行 `| [<id>.md](<id>.md) | <一句话> |`
 *     —— 不存在则创建带 header table 的初始文件
 * 12. 删除原 plan 文件（如果原位置不在新位置即 mv 完成）
 * 13. git add + commit（commit msg 含 plan_id）
 * 14. git worktree remove + git branch -D
 *
 * 任一步失败立即返回 error（短路），不做部分回滚（git 操作不可逆，需要 caller 手工修）。
 *
 * **deps inject 模式**：默认实现走 Node 内置（child_process.execFile + fs/promises +
 * os.homedir + process.cwd），test 通过传 `deps` 参数完全替换为 in-memory mock。
 */

import * as path from 'node:path';

import { parseFrontmatter, stringifyFrontmatter } from '@main/utils/frontmatter';
import { resolvePlanFilePath } from './plan-path-helpers';
import {
  runGitDefault,
  readFileDefault,
  writeFileDefault,
  unlinkDefault,
  mkdirDefault,
  mvDirDefault,
  existsDefault,
  realpathDefault,
  cwdDefault,
  homedirDefault,
} from './_shared/default-impl-deps';

export interface ArchivePlanInput {
  planId: string;
  worktreePath: string;
  /**
   * Caller 显式传的 base branch。
   * REVIEW_36 R2 user feedback：caller 不传（undefined）→ impl 优先读 plan frontmatter.base_branch，
   * frontmatter 也没设 → fallback "main"。caller 显式传 string 始终覆盖 frontmatter（最高优先级）。
   * 旧实现 schema `.default('main')` 让 caller 不传时 string='main' 强制合到 main，与 user CLAUDE
   * §Step 4 「合回切 worktree 时的原分支」契约不符（feature branch 上跑 plan 应合回 feature branch
   * 而非污染 main）。
   */
  baseBranch?: string;
  planFilePathOverride?: string;
  /**
   * archive-plan-tool-ux-followup-20260515 (b)+(c)：caller 显式传 changelog X 数字（如 "122"
   * 单值 / "121,122" 多值 csv）让 impl 把它格式化成 markdown link 写入 ref/plans/INDEX.md
   * 第 3 列「关联 changelog」。caller 不传时 smart update 保留 existing 4 列 row 的原 changelog
   * 列；旧 2 列 row 或新 append 行用 `—` placeholder（不强制清空已有，避免数据丢失）。
   */
  changelogId?: string;
}

export interface ArchivePlanResult {
  archivedPath: string;
  commitHash: string;
  branchDeleted: string;
  worktreeRemoved: string;
  /**
   * archive-plan-tool-ux-followup-20260515 (b)+(c)：plansIndexAppended boolean → plansIndexAction
   * 四态 enum,让 caller 区分 INDEX 行真正发生的事情:
   * - 'created':INDEX 文件不存在,创建带 4 列 header 的初始文件 + 写第一行
   * - 'appended':INDEX 已存在但无本 plan_id 行,append 一行 4 列 row
   * - 'updated':INDEX 已存在且有本 plan_id 行(老 in_progress / 旧 2 列 stub / 老 4 列 completed)
   *   → smart update canonical rewrite 4 列(status=completed + changelog 列 + description 列)
   * - 'unchanged':INDEX 已存在且有本 plan_id 行,smart update 后内容与原行完全相同(罕见 idempotent)
   */
  plansIndexAction: 'created' | 'appended' | 'updated' | 'unchanged';
  finalStatus: 'completed';
  /**
   * archive-plan-tool-ux-followup-20260515 HIGH-2:non-fatal warning 列表(双方独立 HIGH 共识 — silent
   * override 防覆盖走 warn 而非 reject 模式,见 plan §设计决策 Q1 用户决策)。典型场景:
   * - `.claude/plans/<id>.md` 与 `<main-repo>/ref/plans/<id>.md` 同 id 双存,fallback 选 .claude/plans/
   *   后会覆盖 ref/plans/ 历史 completed archive → 加 warning 让 caller 看到
   * 调用方应在 ok return display 时把 warnings 列出来,而非吞掉。空数组表示无 warning。
   */
  warnings: string[];
  /**
   * **plan deep-review-batch-a1-b-followup-r3-20260519 follow-up (spike-reports/ 归档流程缺口)**:
   * spike artifacts 自动归档结果。
   *
   * - `null`: plan 无 spike (`<plan-artifact-dir>/spike-reports/` 不存在),skip
   * - `{ srcPath, dstPath }`: spike-reports/ 成功 mv 到 `<main-repo>/ref/plans/<plan-id>/spike-reports/`
   *   并入 git 归档 commit
   *
   * mv 失败 (EXDEV 跨 fs / perm) 时不阻塞 ok return,落 warnings 数组让 caller 手工 mv。
   */
  spikeReportsArchived: { srcPath: string; dstPath: string } | null;
}

export type ArchivePlanError = { error: string; hint?: string };

export interface ArchivePlanDeps {
  /** 跑 git 子命令；返回 stdout（trim）。失败抛 error。 */
  /**
   * 跑 git 子命令拿 stdout。
   *
   * **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase R3 fix-2 修法 (H2 codex Batch B HIGH-1)**：
   * 加 `opts.raw` 选项让 caller 显式决定是否 trim stdout。默认 raw=false（旧行为：trim 掉首尾
   * whitespace + NUL，适合 rev-parse / commit / status --porcelain 等单行 trim 安全场景）。
   * 仅在 `git status --porcelain=v1 -z` NUL 分隔输出场景必须传 `{ raw: true }`，否则 trim 会
   * 把首列 space（Y 列 unstaged status）也吃掉 → status 错位 → criticalSet 永不命中 → Y 列
   * unstaged critical path 全漏判（H2 现场实测铁证 HISTORICAL bug repro literal,不迁 ref/plans/：`' M plans/INDEX.md\0'.trim()` →
   * `'M plans/INDEX.md\0'` → parser status=`'M '` filename=`'lans/INDEX.md\0'`）。HISTORICAL: bug repro literal block
   */
  runGit?: (args: string[], cwd: string, opts?: { raw?: boolean }) => Promise<string>;
  /** 读文件 utf8。失败抛（典型 ENOENT）。 */
  readFile?: (filePath: string) => Promise<string>;
  /** 写文件 utf8。 */
  writeFile?: (filePath: string, content: string) => Promise<void>;
  /** 删文件。失败抛。 */
  unlink?: (filePath: string) => Promise<void>;
  /** mkdir { recursive }。 */
  mkdir?: (dirPath: string) => Promise<void>;
  /**
   * mv 目录 (src → dst)，用于 spike-reports/ 归档。
   *
   * **plan deep-review-batch-a1-b-followup-r3-20260519 follow-up (spike-reports/ 归档流程缺口)**:
   * 旧实现 archive_plan tool 只 mv plan .md 不动 spike-reports/，导致 spike artifacts 留在
   * `.claude/plans/<plan-id>/spike-reports/` (.gitignore 不入 git 临时位置) → 永久丢失风险。
   * 修法: 加 mvDir deps 让 step 12.5 detect + mv `<plan-artifact-dir>/spike-reports/` 到
   * `<main-repo>/ref/plans/<plan-id>/spike-reports/` 入 git 归档。
   *
   * 默认实现走 `fs.rename`(同 fs 原子 mv);跨 fs 失败 (EXDEV) 抛错让 caller decide:
   * step 12.5 catch EXDEV → warning + 不阻塞 ok return(caller 看 hint 手工 mv)。test 可
   * inject mock 实现非 fs 路径(in-memory state set/del)。
   */
  mvDir?: (src: string, dst: string) => Promise<void>;
  /**
   * rmdir 空目录(spike-reports/ mv 后清父目录用)。失败抛(典型 ENOTEMPTY 父目录非空 / ENOENT
   * 已不存在),caller catch 决定是否 push warning(F7 修法 — 不再 swallow,让 caller 看到
   * sibling artifacts 残留)。
   *
   * **CHANGELOG_169 F7 修法**:之前直接 dynamic import 'node:fs/promises' 调 fs.rmdir,
   * 让 mock test 撞真 fs ENOENT。改 deps 注入后 test 可在 mock 环境注入 no-op 或可控失败。
   */
  rmdir?: (dirPath: string) => Promise<void>;
  /** 文件 / 目录是否存在（true / false，不抛）。 */
  exists?: (p: string) => Promise<boolean>;
  /** realpath 解 symlink，失败抛（caller 决定是否兜底）。 */
  realpath?: (p: string) => Promise<string>;
  /** 当前进程 cwd。 */
  cwd?: () => string;
  /**
   * plan codex-handoff-team-alignment-20260518 P1 Step 1.4：caller sessionRepo.cwdReleaseMarker
   * 反查 seam。Handler 注入 `() => sessionRepo.get(callerSid)?.cwdReleaseMarker ?? null`,
   * impl 用于 4 态 cwd 预检分流（详 archive-plan-impl §step 4）。
   * 默认 fallback `() => null`(impl 走「未持有 marker」分支,即原 2 态行为)。
   */
  cwdReleaseMarker?: () => string | null;
  /**
   * P5 Round 1 reviewer-codex HIGH-1 修法 (release marker seam):
   * archive_plan 在 4 态分流命中状态 (b) [cwd invalid + marker==worktreeReal] / 状态 (c)
   * [cwd valid + 但 inWorktree=false 时 marker 残留] 时，archive 成功后必须 release marker
   * 让 sessionRepo 行回到 null（不变量 5 (b) "release marker, 预检通过"）。Handler 注入
   * `() => Promise.resolve(sessionRepo.clearCwdReleaseMarker(callerSid))` 接同一 sid。
   * 默认 fallback no-op (DEFAULT_DEPS.cwdReleaseMarker = null 时无 marker 可清,no-op 安全)。
   */
  clearCwdReleaseMarker?: () => Promise<void>;
  /** $HOME 路径。 */
  homedir?: () => string;
}

const DEFAULT_DEPS: Required<ArchivePlanDeps> = {
  runGit: runGitDefault,
  readFile: readFileDefault,
  writeFile: writeFileDefault,
  unlink: unlinkDefault,
  mkdir: mkdirDefault,
  mvDir: mvDirDefault,
  rmdir: async (p: string) => {
    const fs2 = await import('node:fs/promises');
    await fs2.rmdir(p);
  },
  exists: existsDefault,
  realpath: realpathDefault,
  cwd: cwdDefault,
  cwdReleaseMarker: () => null,
  clearCwdReleaseMarker: async () => {
    /* P5 Round 1 reviewer-codex HIGH-1 修法 default fallback: no-op (无 marker 可清) */
  },
  homedir: homedirDefault,
};

function isError(x: ArchivePlanResult | ArchivePlanError): x is ArchivePlanError {
  return (x as ArchivePlanError).error !== undefined;
}

/**
 * CHANGELOG_169 F6 [MED]: INDEX TOCTOU 单飞锁(reviewer-claude finding,reviewer-codex 反驳后
 * 部分成立降级 MED)。
 *
 * 防 caller A 与 B 并发 archive 不同 plan_id 时 INDEX read-modify-write 撞 race:
 * - 都 readFile 拿 INDEX 旧版 N 行 → 各自 syncPlansIndex 算 N+1 行 → A writeFile(commit pending)
 *   → B writeFile(commit 覆盖 A 的 row)→ B 的 git commit pathspec 包含 indexPath → A 的
 *   INDEX row 永久丢失(silent corruption)。
 *
 * 单飞锁 pattern 参考 sdk-bridge/recoverer.ts:50,232-245(同款 try/catch/finally delete)。
 * 同进程内 keyed by indexPath: 并发 archive 不同 indexPath(罕见 — 仅多 repo 场景)互不影响,
 * 同 indexPath 并发严格串行。**仅 in-process 防御**(mcp tool deny external caller,无跨进程
 * 调用);未来若 mcp transport 切到 HTTP 多 caller 跨进程,本 Map 失效需补 file-level lock。
 */
const indexSyncFlight: Map<string, Promise<void>> = new Map();

// ===========================================================================
// CHANGELOG_169 F1 Step 1.2: precheck helpers 抽到 archive-plan/precheck-helpers.ts。
// 本文件保持 re-export 让 4 个 test 文件（archive-plan.mainrepo-clean.test.ts /
// archive-plan.base-branch-named-only.test.ts 等）直接 import 这些函数的 path 零改动。
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
import {
  assertMainRepoCleanForArchive,
  assertBaseBranchIsNamedBranch,
} from './archive-plan/precheck-helpers';

export async function archivePlanImpl(
  input: ArchivePlanInput,
  depsOverride?: ArchivePlanDeps,
): Promise<ArchivePlanResult | ArchivePlanError> {
  const deps: Required<ArchivePlanDeps> = { ...DEFAULT_DEPS, ...depsOverride };
  // archive-plan-tool-ux-followup-20260515 HIGH-2:non-fatal warning 数组(silent override 防覆盖等
  // 场景的 warn 收集口子)。impl 走完所有步骤都成功才会 return ok + warnings 透传 caller。
  const warnings: string[] = [];

  // REVIEW_33 H10：worktree_path 存在性预检（放最前，所有其他预检之前）。
  // 旧实现 step 1 直接 `git rev-parse --git-common-dir` in cwd: input.worktreePath；
  // worktree 已被手工 `git worktree remove` / 跨机器迁移 / 误删时 → child_process
  // ENOENT，被 step 1 的 try/catch 抓但 error message 不清晰（混在 git rev-parse 错误
  // 里 caller 难判断到底是 worktree 不存在还是 git 真出错）。修法：先显式 deps.exists
  // 检查，缺失立即返结构化 error 提示「先建 worktree / 修正路径」。
  if (!(await deps.exists(input.worktreePath))) {
    return {
      error: `worktree_path does not exist: ${input.worktreePath}`,
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
      hint: `worktree_path "${input.worktreePath}" is not a valid git worktree (or git not installed). Verify with \`git -C ${input.worktreePath} status\`.`,
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
      hint: 'archive_plan requires worktree to be on a named branch so it can be ff-merged into base_branch and then deleted.',
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
        error: `plan_file_path override does not exist: ${input.planFilePathOverride}`,
      };
    }
    // archive-plan-tool-ux-followup-20260515 HIGH-1 (claude 单方 + 现场验证): plan_file_path
    // 文件名 stem 必须等于 plan_id。否则 step 10 archivedPath 用 plan_id 派生 = `<main-repo>
    // /ref/plans/<plan_id>.md` 与 caller 给的 plan_file_path 文件完全脱节,step 12 因 path !==
    // archivedPath 删 caller 文件,silent unlink 风险。impl 层校验给清晰 hint(schema 是 record
    // shape 不支持 cross-field refine,故落 impl 而非 schema)。
    const overrideStem = path.basename(input.planFilePathOverride, '.md');
    if (overrideStem !== input.planId) {
      return {
        error: `plan_file_path stem "${overrideStem}" does not match plan_id "${input.planId}"`,
        hint: `archived path / INDEX key are derived from plan_id (\`<main-repo>/ref/plans/${input.planId}.md\`); step 12 unlink would silently move the plan_file_path file. Either rename plan_file_path to \`${input.planId}.md\` or change plan_id to "${overrideStem}". 修法 followup 20260515 HIGH-1.`,
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
        `补跑 baton-cleanup phase 1（其参数 { caller_session_id, plan_id? }，单独 shutdown 同 team active+dormant teammate ` +
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
    return { error: `realpath of worktree_path failed: ${(e as Error).message}` };
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
          hint: `Cross-worktree archive is not allowed. Either call exit_worktree on the marker's worktree first (to clear the stale marker), or call archive_plan with worktree_path matching the held marker (${markerReal}).`,
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
        error: `caller cwd ${callerCwd} is invalid (realpath failed)${markerReal ? ` and marker (${markerReal}) does not match worktree_path (${worktreeReal})` : ' and no enter_worktree marker held'}`,
        hint: markerReal
          ? `cwd resilience guard rail: caller cwd was deleted/moved while a stale marker for a different worktree remains. Either call exit_worktree({ worktree_path: '${markerReal}' }) on the held worktree first to clear the stale marker, or call archive_plan with worktree_path matching the marker.`
          : `cwd resilience guard rail: caller cwd was deleted/moved without an enter_worktree marker fallback. Restart the caller session in a valid working directory before retrying archive_plan, or pass a fresh caller_session_id whose sessionRepo.cwd is valid.`,
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
  // reviewer-codex finding（双方反驳轮裁决 HIGH 真问题）：caller 误传另一 plan 的 worktree_path 时，
  // 之前的代码不校验 fm.worktree_path / fm.plan_id 与输入一致 → silent corruption（plan-A 错标
  // completed + plan-B worktree 被删 + ff-merge 合错 commit + plan-B 工作整片丢失）。典型触发：
  // user 跑 2-3 plan 收尾时 tab-complete 撞同名 dir / 复制粘贴撞错路径。
  //
  // **D7 决策**（向后兼容老 plan）：字段存在严格校验,字段缺失 soft warn 不 reject。新 plan 模板
  // 已含 plan_id / worktree_path frontmatter（详 resources/claude-config/CLAUDE.md §Step 1
  // plan 内容文档），老 plan 没字段时不破坏归档。
  if (typeof fm.plan_id === 'string' && fm.plan_id !== input.planId) {
    return {
      error: `plan_id mismatch: frontmatter plan_id="${fm.plan_id}" but archive_plan called with planId="${input.planId}"`,
      hint: `Caller likely passed wrong worktree_path for this plan_id (or vice versa). Refusing to ff-merge / write / unlink to avoid silent corruption (the wrong-binding case would merge another worktree's branch + delete another worktree + mark this plan completed). Verify with \`head -10 ${planFilePath}\` then call archive_plan with matching planId + worktreePath pair.`,
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
        hint: `Caller likely passed wrong worktree_path for this plan_id. Refusing to ff-merge / write / unlink to avoid silent corruption (the wrong-binding case would merge another worktree's branch + delete another worktree + mark this plan completed). Verify plan frontmatter or correct args.worktree_path.`,
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

  // 7. fast-forward merge worktree branch → base_branch
  // REVIEW_33 H1：旧实现直接 `git merge --ff-only worktreeBranch` 在 mainRepo 当前 HEAD 上 ff，
  // 与「ff merge into base_branch」契约不符——caller 当前 checkout 在 feature-x 时把 worktree
  // branch 合进 feature-x 而非 main。修法：merge 前先 verify base_branch 存在 + checkout 到
  // base_branch（merge 后不切回，假设 caller 默认在 base_branch 工作；如不在 caller 自己处理）。
  //
  // REVIEW_36 R2 user feedback：base_branch 解析优先级 = caller 显式 input.baseBranch >
  // plan frontmatter.base_branch (plan 创建时记录) > "main" fallback。旧 schema `.default('main')`
  // 让 caller 不传时强制合到 main，feature branch 上跑 plan 会污染主线。frontmatter 字段让用户
  // 在 plan 创建时记录原分支（user CLAUDE.md §Step 2 plan 内容文档已加该字段说明）。
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
      error: baseBranchCheck.error ?? `base_branch validation failed for "${effectiveBaseBranch}"`,
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
  // status check / base_branch fallback / fm 元数据派生(已用完),不再参与 step 10 /
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
  // (step 5 plan status check 撞 already completed reject),marker 残留对**本 plan_id** 无
  // 功能影响,但若 caller session 后续再调 archive_plan 跑别的 plan_id,step 4 4-state cwd
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
  try {
    await deps.runGit(['worktree', 'remove', input.worktreePath], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'git-worktree-remove',
      e as Error,
      'Worktree may have uncommitted state added between predecessor check and remove. Manually run `git worktree remove --force` and `git branch -D`.',
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
    archivedPath,
    commitHash: archiveCommit,
    branchDeleted: worktreeBranch,
    worktreeRemoved: input.worktreePath,
    plansIndexAction,
    finalStatus: 'completed',
    warnings,
    spikeReportsArchived,
  };
}

/** YYYY-MM-DD 本地时区（与 plan 文件 frontmatter `created_at` 风格一致）。 */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 取 frontmatter block 后的所有正文（含 frontmatter 后第一个换行之后的所有字节）。 */
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  if (!m) return text;
  return text.slice(m[0].length);
}

// ===========================================================================
// CHANGELOG_169 F1 Step 1.3: INDEX sync helpers 抽到 archive-plan/index-sync-helpers.ts。
// 本文件保持 re-export 让 test 文件直接 import 这些函数的 path 零改动。
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
import {
  escapeTableCell,
  formatChangelogCell,
  syncPlansIndex,
} from './archive-plan/index-sync-helpers';


/**
 * REVIEW_33 H9：post-ff-merge 阶段标识。一旦 ff-merge 成功（step 7 后），main HEAD
 * 已推进到 worktree branch tip。**一般阶段（step 10a/10b/11/12/13/14）不可简单
 * `git reset --hard ORIG_HEAD` 回滚**（已累积写入 archived plan / INDEX / unlink 原 plan
 * / git commit 等中间状态会被销毁），需手工补完 step 标识对应的 cleanup（write
 * archived / sync INDEX / unlink plan / git add+commit / git worktree remove / git branch -D）。
 * **唯一例外是 step 8b/8c**（无任何 fs 写入累积，仅 ff-merge 已成功），此时
 * `git reset --hard ORIG_HEAD` 干净安全，详 8c phaseHint 推荐路径。
 *
 * 任何后续 step 失败时 caller 必须知道：(1) main 已收到 worktree 的 commits（不是
 * 「nothing happened」可重试场景）；(2) 应按 phase 标识查 phaseHint 选 cleanup 路径
 * （8b/8c 走 reset --hard ORIG_HEAD;一般 phase 按 step 手工补完后续）。
 *
 * 10 个 phase 一一对应 step 8 / 8b / 10a / 10b / 11 / 12 / 13a / 13b / 14a / 14b
 * (plan archive-plan-content-overwritten-fix-20260515 加 'reread-plan-after-ffmerge'
 * phase 对应 step 8b 重新 read 失败 + 8c fresh status 漂移拒绝;两 case 复用同一 phase
 * value,具体原因看 error 内 message)。
 */
export type PostFfMergePhase =
  | 'rev-parse-HEAD' // step 8
  | 'reread-plan-after-ffmerge' // step 8b (plan archive-plan-content-overwritten-fix-20260515)
  | 'mkdir-plans-dir' // step 10a
  | 'write-archived-plan' // step 10b
  | 'sync-plans-INDEX' // step 11
  | 'unlink-original-plan' // step 12
  | 'git-add' // step 13a
  | 'git-commit' // step 13b
  | 'archive-rev-parse-HEAD' // step 13c (REVIEW_56 Batch B R1 MED-1: 拿 archive commit hash)
  | 'git-worktree-remove' // step 14a
  | 'git-branch-D'; // step 14b

const POST_FF_MERGE_HINT_GENERIC =
  'ff-merge 已完成（main HEAD 已推进到 worktree branch tip），失败发生在 post-ff-merge 阶段。' +
  '不能简单 retry archive_plan（会撞 "branch already merged" 等已成功步骤）；按 phase 标识手工补完后续 cleanup。';

/**
 * archive-plan-tool-ux-followup-20260515 R1 fix MED-2 共识(双方独立):统一 retry-invariant prefix。
 * 7 phase 专用 phaseHint(R1 follow-up Phase 2.1)覆盖了 GENERIC,但除 mkdir-plans-dir 外都丢了
 * 「不能整体 retry archive_plan」的关键 invariant — caller 看到精细 manual recovery 步骤可能
 * 误以为按完后可 re-call archive_plan retry → 第二次跑 ff-merge 撞「branch already merged」/
 * merge already done 撞墙;或 caller 已手工补完 cleanup 后 retry 触发重复 git add / commit /
 * worktree remove "validation failed"。
 *
 * 修法:postFfMergeErr 内部把 phaseHint 与 retry-invariant prefix 拼起来,保 caller 任何 phase
 * 失败都看到这一条。GENERIC fallback 自身已含该语义,无需重复 prefix(if phaseHint missing)。
 */
const POST_FF_MERGE_RETRY_INVARIANT_PREFIX =
  '⚠ Cannot retry archive_plan as a whole (would hit "branch already merged" / "validation failed" on ff-merge or repeat already-completed steps). ' +
  'Manually complete remaining cleanup steps according to the phase below, then DO NOT re-call archive_plan; the worktree branch is already merged into base_branch.\n\n';

/**
 * REVIEW_33 H9：统一 post-ff-merge error 构造器。error 文本前缀加 `[post-ff-merge:<phase>]`
 * 让 caller 一眼识别这是 ff-merge 之后的失败（不是 ff-merge 前的可重试失败），hint
 * 默认提示「不能简单 retry，按 phase 手工补完」；caller 可传 phaseHint override 给
 * 特定 phase 的精细 hint（如 git-worktree-remove 提示用 --force）。
 *
 * archive-plan-tool-ux-followup-20260515 R1 fix MED-2:phaseHint 传入时,自动加 retry-invariant
 * prefix(GENERIC fallback 自身已含该语义不重复)。
 */
export function postFfMergeErr(
  phase: PostFfMergePhase,
  e: Error,
  phaseHint?: string,
): ArchivePlanError {
  const hint = phaseHint
    ? POST_FF_MERGE_RETRY_INVARIANT_PREFIX + phaseHint
    : POST_FF_MERGE_HINT_GENERIC;
  return {
    error: `[post-ff-merge:${phase}] ${e.message}`,
    hint,
  };
}

// 测试 helper export
export { isError as _isArchivePlanError };
