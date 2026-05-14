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
 * 5. 解析 plan 文件路径（显式给 > <main-repo>/.claude/plans/<id>.md > ~/.claude/plans/<id>.md）
 * 6. 读 plan + parseFrontmatter，预检 status ≠ completed（防误调；abandoned 也允许收口）
 * 7. fast-forward merge：在 main repo 跑 `git merge --ff-only <worktree-branch>`
 * 8. 拿最终 commit hash：`git -C <main-repo> rev-parse HEAD`
 * 9. 更新 frontmatter：status=completed / final_commit / completed_at（YYYY-MM-DD 本地时区）
 * 10. 写新 plan 到 `<main-repo>/plans/<plan_id>.md`（recursive mkdir <main>/plans/）
 * 11. 同步 `<main-repo>/plans/INDEX.md`：append 一行 `| [<id>.md](<id>.md) | <一句话> |`
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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { parseFrontmatter, stringifyFrontmatter } from '@main/utils/frontmatter';

const execFileAsync = promisify(execFile);

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
}

export interface ArchivePlanResult {
  archivedPath: string;
  commitHash: string;
  branchDeleted: string;
  worktreeRemoved: string;
  plansIndexAppended: boolean;
  finalStatus: 'completed';
}

export type ArchivePlanError = { error: string; hint?: string };

export interface ArchivePlanDeps {
  /** 跑 git 子命令；返回 stdout（trim）。失败抛 error。 */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** 读文件 utf8。失败抛（典型 ENOENT）。 */
  readFile?: (filePath: string) => Promise<string>;
  /** 写文件 utf8。 */
  writeFile?: (filePath: string, content: string) => Promise<void>;
  /** 删文件。失败抛。 */
  unlink?: (filePath: string) => Promise<void>;
  /** mkdir { recursive }。 */
  mkdir?: (dirPath: string) => Promise<void>;
  /** 文件 / 目录是否存在（true / false，不抛）。 */
  exists?: (p: string) => Promise<boolean>;
  /** realpath 解 symlink，失败抛（caller 决定是否兜底）。 */
  realpath?: (p: string) => Promise<string>;
  /** 当前进程 cwd。 */
  cwd?: () => string;
  /** $HOME 路径。 */
  homedir?: () => string;
}

const DEFAULT_DEPS: Required<ArchivePlanDeps> = {
  runGit: async (args, cwd) => {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.toString().trim();
  },
  readFile: async (p) => fs.readFile(p, 'utf8'),
  writeFile: async (p, c) => fs.writeFile(p, c, 'utf8'),
  unlink: async (p) => fs.unlink(p),
  mkdir: async (p) => {
    await fs.mkdir(p, { recursive: true });
  },
  exists: async (p) => {
    try {
      const _: Stats = await fs.stat(p);
      void _;
      return true;
    } catch {
      return false;
    }
  },
  realpath: async (p) => fs.realpath(p),
  cwd: () => process.cwd(),
  homedir: () => os.homedir(),
};

function isError(x: ArchivePlanResult | ArchivePlanError): x is ArchivePlanError {
  return (x as ArchivePlanError).error !== undefined;
}

export async function archivePlanImpl(
  input: ArchivePlanInput,
  depsOverride?: ArchivePlanDeps,
): Promise<ArchivePlanResult | ArchivePlanError> {
  const deps: Required<ArchivePlanDeps> = { ...DEFAULT_DEPS, ...depsOverride };

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

  // 4. 预检 cwd 不在 worktree 内
  const callerCwd = deps.cwd();
  let cwdReal: string;
  let worktreeReal: string;
  try {
    cwdReal = await deps.realpath(callerCwd);
    worktreeReal = await deps.realpath(input.worktreePath);
  } catch (e) {
    return { error: `realpath failed: ${(e as Error).message}` };
  }
  // worktree 子树检测：cwdReal 必须 startWith worktreeReal + sep（或精确等于）
  if (cwdReal === worktreeReal || cwdReal.startsWith(worktreeReal + path.sep)) {
    return {
      error: `caller cwd ${cwdReal} is inside the worktree ${worktreeReal}`,
      hint: 'mcp tool cannot call ExitWorktree (Claude CLI internal tool). Caller must ExitWorktree first (so cwd is outside the worktree), then call archive_plan again.',
    };
  }

  // 5. 解析 plan 文件路径
  let planFilePath: string;
  if (input.planFilePathOverride) {
    if (!(await deps.exists(input.planFilePathOverride))) {
      return {
        error: `plan_file_path override does not exist: ${input.planFilePathOverride}`,
      };
    }
    planFilePath = input.planFilePathOverride;
  } else {
    const projectLocal = path.join(mainRepo, '.claude', 'plans', `${input.planId}.md`);
    const userGlobal = path.join(deps.homedir(), '.claude', 'plans', `${input.planId}.md`);
    if (await deps.exists(projectLocal)) {
      planFilePath = projectLocal;
    } else if (await deps.exists(userGlobal)) {
      planFilePath = userGlobal;
    } else {
      return {
        error: `plan file not found at either default location`,
        hint: `Tried: ${projectLocal}\n       ${userGlobal}\nPass plan_file_path explicitly to override.`,
      };
    }
  }

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
  // 后果：abandoned plan 会被 ff-merge 到 main + 写入 plans/ git 历史（违反 user CLAUDE.md
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
      hint: `archive_plan only handles in_progress → completed transitions. For abandoned plans follow user CLAUDE.md §Step 4 \"中止\" path: keep frontmatter status=abandoned, ExitWorktree(action: keep), then manual \`git worktree remove --force\` + \`git branch -D\`. Don't move plan into <main-repo>/plans/.`,
    };
  }
  if (fm.status !== 'in_progress') {
    return {
      error: `plan status must be "in_progress" but got "${fm.status ?? '<missing>'}"`,
      hint: `Edit ${planFilePath} frontmatter to set \`status: in_progress\` before calling archive_plan, or use a status value matching the documented lifecycle (in_progress / completed / abandoned).`,
    };
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
  try {
    await deps.runGit(['rev-parse', '--verify', effectiveBaseBranch], mainRepo);
  } catch (e) {
    return {
      error: `base_branch "${effectiveBaseBranch}" does not exist in main repo: ${(e as Error).message}`,
      hint: `REVIEW_36 R2: base_branch resolves from caller arg > plan frontmatter.base_branch > "main" fallback. Pass an existing branch name via base_branch arg, or set frontmatter base_branch in ${planFilePath}. Verify with \`git -C ${mainRepo} branch --list\`.`,
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
    return postFfMergeErr('rev-parse-HEAD', e as Error);
  }

  // 9. 更新 frontmatter
  const today = formatLocalDate(new Date());
  const newFm: Record<string, string> = {
    ...fm,
    status: 'completed',
    final_commit: finalCommit,
    completed_at: today,
  };

  // 10. 写新 plan
  const archivedDir = path.join(mainRepo, 'plans');
  const archivedPath = path.join(archivedDir, `${input.planId}.md`);
  try {
    await deps.mkdir(archivedDir);
  } catch (e) {
    return postFfMergeErr('mkdir-plans-dir', e as Error);
  }
  // body 是 frontmatter block 之后的全部正文（保持原样）
  const body = stripFrontmatter(planContent);
  const newContent = `${stringifyFrontmatter(newFm)}\n${body}`;
  try {
    await deps.writeFile(archivedPath, newContent);
  } catch (e) {
    return postFfMergeErr('write-archived-plan', e as Error);
  }

  // 11. 同步 plans/INDEX.md（存在则 append 一行 / 不存在则创建带 header）
  const indexPath = path.join(archivedDir, 'INDEX.md');
  const summary = (fm.description ?? fm.plan_id ?? input.planId).slice(0, 200);
  let plansIndexAppended = false;
  try {
    const indexExists = await deps.exists(indexPath);
    if (indexExists) {
      const indexContent = await deps.readFile(indexPath);
      // 防重复 append（如果同 plan_id 已经在 INDEX 里则跳过）
      if (!indexContent.includes(`(${input.planId}.md)`)) {
        const appendLine = `| [${input.planId}.md](${input.planId}.md) | ${summary} |\n`;
        const sep = indexContent.endsWith('\n') ? '' : '\n';
        await deps.writeFile(indexPath, indexContent + sep + appendLine);
        plansIndexAppended = true;
      }
    } else {
      const initial =
        '# Plans 索引\n\n' +
        '> 已归档 plan 一行表（archive_plan tool 自动维护）。\n\n' +
        '| 文件 | 概要 |\n' +
        '|---|---|\n' +
        `| [${input.planId}.md](${input.planId}.md) | ${summary} |\n`;
      await deps.writeFile(indexPath, initial);
      plansIndexAppended = true;
    }
  } catch (e) {
    return postFfMergeErr('sync-plans-INDEX', e as Error);
  }

  // 12. 删除原 plan 文件（如果原位置不在新位置）
  if (path.resolve(planFilePath) !== path.resolve(archivedPath)) {
    try {
      await deps.unlink(planFilePath);
    } catch (e) {
      return postFfMergeErr('unlink-original-plan', e as Error);
    }
  }

  // 13. git add + commit
  const filesToAdd = [
    path.relative(mainRepo, archivedPath),
    path.relative(mainRepo, indexPath),
  ];
  try {
    await deps.runGit(['add', ...filesToAdd], mainRepo);
  } catch (e) {
    return postFfMergeErr('git-add', e as Error);
  }
  const commitMsg = `docs(plans): 归档 ${input.planId} plan + 同步 INDEX (archive_plan)`;
  try {
    await deps.runGit(['commit', '-m', commitMsg], mainRepo);
  } catch (e) {
    return postFfMergeErr('git-commit', e as Error);
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
    commitHash: finalCommit,
    branchDeleted: worktreeBranch,
    worktreeRemoved: input.worktreePath,
    plansIndexAppended,
    finalStatus: 'completed',
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

/**
 * REVIEW_33 H9：post-ff-merge 阶段标识。一旦 ff-merge 成功（step 7 后），main HEAD
 * 已推进到 worktree branch tip，**不可简单回滚**（reset --hard 风险高）。任何后续
 * step 失败时 caller 必须知道：(1) main 已收到 worktree 的 commits（不是「nothing
 * happened」可重试场景）；(2) 应手工补完 step 标识对应的 cleanup（write archived /
 * sync INDEX / unlink plan / git add+commit / git worktree remove / git branch -D）。
 *
 * 7 个 phase 一一对应 step 8-14。
 */
export type PostFfMergePhase =
  | 'rev-parse-HEAD' // step 8
  | 'mkdir-plans-dir' // step 10a
  | 'write-archived-plan' // step 10b
  | 'sync-plans-INDEX' // step 11
  | 'unlink-original-plan' // step 12
  | 'git-add' // step 13a
  | 'git-commit' // step 13b
  | 'git-worktree-remove' // step 14a
  | 'git-branch-D'; // step 14b

const POST_FF_MERGE_HINT_GENERIC =
  'ff-merge 已完成（main HEAD 已推进到 worktree branch tip），失败发生在 post-ff-merge 阶段。' +
  '不能简单 retry archive_plan（会撞 "branch already merged" 等已成功步骤）；按 phase 标识手工补完后续 cleanup。';

/**
 * REVIEW_33 H9：统一 post-ff-merge error 构造器。error 文本前缀加 `[post-ff-merge:<phase>]`
 * 让 caller 一眼识别这是 ff-merge 之后的失败（不是 ff-merge 前的可重试失败），hint
 * 默认提示「不能简单 retry，按 phase 手工补完」；caller 可传 phaseHint override 给
 * 特定 phase 的精细 hint（如 git-worktree-remove 提示用 --force）。
 */
export function postFfMergeErr(
  phase: PostFfMergePhase,
  e: Error,
  phaseHint?: string,
): ArchivePlanError {
  return {
    error: `[post-ff-merge:${phase}] ${e.message}`,
    hint: phaseHint ?? POST_FF_MERGE_HINT_GENERIC,
  };
}

// 测试 helper export
export { isError as _isArchivePlanError };
