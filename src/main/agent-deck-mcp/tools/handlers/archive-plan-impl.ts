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
  /**
   * archive-plan-tool-ux-followup-20260515 (b)+(c)：caller 显式传 changelog X 数字（如 "122"
   * 单值 / "121,122" 多值 csv）让 impl 把它格式化成 markdown link 写入 plans/INDEX.md
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
   * - `.claude/plans/<id>.md` 与 `<main-repo>/plans/<id>.md` 同 id 双存,fallback 选 .claude/plans/
   *   后会覆盖 plans/ 历史 completed archive → 加 warning 让 caller 看到
   * 调用方应在 ok return display 时把 warnings 列出来,而非吞掉。空数组表示无 warning。
   */
  warnings: string[];
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
  cwdReleaseMarker: () => null,
  clearCwdReleaseMarker: async () => {
    /* P5 Round 1 reviewer-codex HIGH-1 修法 default fallback: no-op (无 marker 可清) */
  },
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
      if (markerReal !== null) {
        // 状态 (c) plan §不变量 5: cwd valid + marker present → WARN 但 cwd 优先
        // caller 持 marker 但 cwd 已移出 worktree,典型场景 caller 手动 cd 出 worktree 但忘 exit_worktree。
        // 不阻塞 archive,但加 warning 提示并 release marker（archive 后 marker stale）。
        warnings.push(
          `cwd ${cwdReal} is outside worktree but enter_worktree marker (${markerReal}) is held — caller likely forgot exit_worktree before changing cwd. Marker will be released after archive succeeds.`,
        );
        releaseMarkerOnSuccess = true;
      }
      // 状态 (a) plan §不变量 5: cwd valid + marker null + !inWorktree → 直接放过 (claude builtin
      // caller 已 ExitWorktree, 现有路径不变)。
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

  // 5. 解析 plan 文件路径
  let planFilePath: string;
  if (input.planFilePathOverride) {
    if (!(await deps.exists(input.planFilePathOverride))) {
      return {
        error: `plan_file_path override does not exist: ${input.planFilePathOverride}`,
      };
    }
    // archive-plan-tool-ux-followup-20260515 HIGH-1 (claude 单方 + 现场验证): plan_file_path
    // 文件名 stem 必须等于 plan_id。否则 step 10 archivedPath 用 plan_id 派生 = `<main-repo>
    // /plans/<plan_id>.md` 与 caller 给的 plan_file_path 文件完全脱节,step 12 因 path !==
    // archivedPath 删 caller 文件,silent unlink 风险。impl 层校验给清晰 hint(schema 是 record
    // shape 不支持 cross-field refine,故落 impl 而非 schema)。
    const overrideStem = path.basename(input.planFilePathOverride, '.md');
    if (overrideStem !== input.planId) {
      return {
        error: `plan_file_path stem "${overrideStem}" does not match plan_id "${input.planId}"`,
        hint: `archived path / INDEX key are derived from plan_id (\`<main-repo>/plans/${input.planId}.md\`); step 12 unlink would silently move the plan_file_path file. Either rename plan_file_path to \`${input.planId}.md\` or change plan_id to "${overrideStem}". 修法 followup 20260515 HIGH-1.`,
      };
    }
    planFilePath = input.planFilePathOverride;
  } else {
    // archive-plan-tool-ux-followup-20260515 (a): fallback 链加 `<main-repo>/plans/<id>.md`
    // 中间档(双 reviewer 共识 HIGH:本项目实际惯例所有 stub plan 都直接创在 plans/,旧 fallback
    // 缺中间档 → caller 不传 plan_file_path 时全失败)。顺序 .claude/plans/ > plans/ >
    // ~/.claude/plans/(贴 user CLAUDE.md §Step 2 文档约定 .claude/plans/ in_progress 优先,
    // 但 plans/ 中间档兜底本项目实际惯例)。
    const projectLocal = path.join(mainRepo, '.claude', 'plans', `${input.planId}.md`);
    const projectArchived = path.join(mainRepo, 'plans', `${input.planId}.md`);
    const userGlobal = path.join(deps.homedir(), '.claude', 'plans', `${input.planId}.md`);
    if (await deps.exists(projectLocal)) {
      planFilePath = projectLocal;
    } else if (await deps.exists(projectArchived)) {
      planFilePath = projectArchived;
    } else if (await deps.exists(userGlobal)) {
      planFilePath = userGlobal;
    } else {
      return {
        error: `plan file not found at any default location`,
        hint: `Tried (in order): ${projectLocal}\n                  ${projectArchived}\n                  ${userGlobal}\nPass plan_file_path explicitly to override.`,
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
    return postFfMergeErr(
      'rev-parse-HEAD',
      e as Error,
      `git rev-parse HEAD failed in main repo (rare — git internal state / perm). ` +
        `Manually run \`git -C ${mainRepo} rev-parse HEAD\` to get current hash; ` +
        `complete steps 9-14 manually (update plan frontmatter with status=completed + final_commit + completed_at, write to ${path.join(mainRepo, 'plans', `${input.planId}.md`)}, sync plans/INDEX.md, unlink original plan, git add+commit, worktree remove, branch -D).`,
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
  const archivedDir = path.join(mainRepo, 'plans');
  const archivedPath = path.join(archivedDir, `${input.planId}.md`);
  // archive-plan-tool-ux-followup-20260515 HIGH-2 (双方独立 HIGH 共识) silent override warn:
  // 同 plan_id 同时存在 `.claude/plans/<id>.md` AND `<main-repo>/plans/<id>.md`(caller 误操作 /
  // 历史遗留)→ fallback 链选 .claude/plans/ 后 step 10 静默覆盖 plans/ 历史 completed archive。
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

  // 11. 同步 plans/INDEX.md(archive-plan-tool-ux-followup-20260515 (b)+(c) syncPlansIndex helper
  // 重写):4 列 canonical 格式 `| 文件 | 状态 | 关联 changelog | 概要 |`,smart update existing
  // 行(替换 status / changelog / description 列),caller 不传 changelog_id 时保留老 4 列 changelog
  // 列 / 旧 2 列 row 或新 append 用 `—` placeholder。description / changelog 列 escape `|` + 换行。
  const indexPath = path.join(archivedDir, 'INDEX.md');
  // freshFm 而非 step 6 fm — 与 step 9-10 frontmatter / body 写入保持同源
  const rawSummary = (freshFm.description ?? freshFm.plan_id ?? input.planId).slice(0, 200);
  const summary = escapeTableCell(rawSummary);
  const changelogCell = formatChangelogCell(input.changelogId);
  let plansIndexAction: ArchivePlanResult['plansIndexAction'];
  try {
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
    plansIndexAction = syncResult.action;
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

  // 13. git add + commit
  const filesToAdd = [
    path.relative(mainRepo, archivedPath),
    path.relative(mainRepo, indexPath),
  ];
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
  const commitMsg = `docs(plans): 归档 ${input.planId} plan + 同步 INDEX (archive_plan)`;
  try {
    await deps.runGit(['commit', '-m', commitMsg], mainRepo);
  } catch (e) {
    return postFfMergeErr(
      'git-commit',
      e as Error,
      `git commit failed (pre-commit hook reject / commit-msg validator failed / nothing to commit / signing key issue). ` +
        `Inspect the git error and fix root cause (skip hook with --no-verify only if necessary, fix message format, configure signing key); ` +
        `then manually \`git -C ${mainRepo} commit -m "${commitMsg}"\` and complete step 14 manually (worktree remove / branch -D).`,
    );
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

  // P5 Round 1 reviewer-codex HIGH-1 修法 (release marker on archive success):
  // 4 态分流 step 4 决定 releaseMarkerOnSuccess flag 后,archive 完整跑完所有 git/fs 步骤再 release。
  // archive 中途任一步失败 (postFfMergeErr / runGit throw) 都已通过 return 短路,marker 保留让 caller
  // 修复后可重试。release 失败仅 warn 不阻塞 ok return（archive 已成功,marker 残留属轻微 leak）。
  if (releaseMarkerOnSuccess) {
    try {
      await deps.clearCwdReleaseMarker();
    } catch (e) {
      warnings.push(
        `archive succeeded but clearCwdReleaseMarker failed: ${(e as Error).message}. Caller may need to manually clear via exit_worktree or session close.`,
      );
    }
  }

  return {
    archivedPath,
    commitHash: finalCommit,
    branchDeleted: worktreeBranch,
    worktreeRemoved: input.worktreePath,
    plansIndexAction,
    finalStatus: 'completed',
    warnings,
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
 * archive-plan-tool-ux-followup-20260515 (c) HIGH-5 (claude HIGH-5 / codex LOW-2 共识):
 * markdown table cell escape — frontmatter description / changelog 列含 `|` 或换行会破表 (列被切错
 * / 多行 row)。写入 INDEX 表前必经此 escape。
 */
export function escapeTableCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * archive-plan-tool-ux-followup-20260515 (b) LOW-1 (codex) / claude MED-5: caller 传 changelog_id
 * (string + csv 解析,schema 已 regex 守门 `^\d+(,\d+)*$`) → 拼成 markdown link 单值或 ` / ` 分隔多值。
 * - "122" → "[122](../changelog/CHANGELOG_122.md)"
 * - "121,122" → "[121](../changelog/CHANGELOG_121.md) / [122](../changelog/CHANGELOG_122.md)"
 * - undefined / 空串 → null (caller 不传,smart update 时按 fallback 处理)
 *
 * markdown link 不需 escape (`(` `)` `[` `]` 是 markdown link 语法本身,但 `|` 会破表 — link
 * url/text 都是纯数字 + 斜杠 + 下划线无 pipe,安全)。
 */
export function formatChangelogCell(changelogId: string | undefined): string | null {
  if (!changelogId) return null;
  const ids = changelogId
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return null;
  return ids.map((id) => `[${id}](../changelog/CHANGELOG_${id}.md)`).join(' / ');
}

/**
 * archive-plan-tool-ux-followup-20260515 (b)+(c) syncPlansIndex helper(双方 reviewer 共识 HIGH:
 * INDEX 行 smart update 不能 naive split,必须行级匹配锚定行首)。
 *
 * **行为契约**:
 * - existingContent === null → action='created':写带 4 列 header 的初始 INDEX(`| 文件 | 状态 |
 *   关联 changelog | 概要 |`) + 第一行 4 列 row
 * - existingContent 已含 plan_id 行(行首 `^| [<plan_id>.md](`)→ action='updated':canonical
 *   rewrite 该行为 4 列(status='completed' / changelog 列按规则 / description 列覆盖);完全相同 →
 *   action='unchanged'(caller 端可跳过 writeFile)
 * - existingContent 不含 plan_id 行 → action='appended':append 一行 4 列 row 到 INDEX 末尾
 *
 * **caller 不传 changelog_id 时(opts.changelogCell === null)**:smart update 已存在 4 列 row 时
 * 保留原 changelog 列(避免清空已有);旧 2 列 row 或新 append 用 `—` placeholder。
 *
 * **行级 regex 锚定行首 `^| [<plan_id>.md](`** 而非 `indexContent.includes('(${planId}.md)')` —
 * 后者会撞 description / changelog 列含同款 substring 误命中(罕见但可能,如 description 引用其他
 * plan link)。锚定行首 + 文件链接前缀语法保证只匹配 row 第一列。
 */
export type PlansIndexAction = 'created' | 'appended' | 'updated' | 'unchanged';
export interface SyncPlansIndexOptions {
  planId: string;
  /** 已 escape + slice 200 char 的 description,直接写 INDEX 第 4 列。 */
  description: string;
  /**
   * caller 传 changelog_id 时拼成的 markdown link string (formatChangelogCell 输出);
   * caller 不传时 null,smart update 时保留老 4 列 changelog 列 / append 时用 `—` placeholder。
   */
  changelogCell: string | null;
}
export interface SyncPlansIndexResult {
  newContent: string;
  action: PlansIndexAction;
}

export function syncPlansIndex(
  existingContent: string | null,
  opts: SyncPlansIndexOptions,
): SyncPlansIndexResult {
  const { planId, description, changelogCell } = opts;
  const fileLink = `[${planId}.md](${planId}.md)`;
  // regex 锚定行首 + 文件链接前缀:`^| [<plan_id>.md](` 转义 plan_id 中 regex 特殊字符
  // (按 schema plan_id charset `[A-Za-z0-9._-]` 含 `.`)
  const escapedPlanId = planId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const planLineRegex = new RegExp(`^\\| \\[${escapedPlanId}\\.md\\]\\(`);

  // case 1: 不存在 INDEX → 创建 4 列 header + 4 列 row
  if (existingContent === null) {
    const initial =
      '# Plans 索引\n\n' +
      '> 已归档 plan 一行表（archive_plan tool 自动维护)。\n\n' +
      '| 文件 | 状态 | 关联 changelog | 概要 |\n' +
      '|------|------|---------------|------|\n' +
      `| ${fileLink} | completed | ${changelogCell ?? '—'} | ${description} |\n`;
    return { newContent: initial, action: 'created' };
  }

  // archive-plan-tool-ux-followup-20260515 R1 fix codex MED-1:旧 2 列 header
  // (`| 文件 | 概要 |` + `|---|---|`)在 (b)+(c) 升级为 4 列 row 后会与 row 错位
  // (4 列 row 挂 2 列 header 下,markdown 渲染破损)。修法:syncPlansIndex 在 case 2 /
  // case 3 路径前先 detect + canonicalize 升级 header,让 archive_plan 自动平滑迁移
  // 老 INDEX 而非要求 caller 手工 fix。upgrade 自身 idempotent(第二次跑无 2 列
  // header 检测不到即 no-op)。
  const headerUpgrade = upgradeIndexHeader(existingContent);
  const workingContent = headerUpgrade.content;

  const lines = workingContent.split('\n');
  const targetIdx = lines.findIndex((line) => planLineRegex.test(line));

  // case 2: 已含 plan_id 行 → smart update canonical rewrite 4 列
  if (targetIdx >= 0) {
    // parse 老行用 split('|') 拿 cells;`split('|')` 第一段空(行首 `|`)+ 中间 cells + 末尾空
    // (行尾 `|`)。slice(1, -1) 拿 cells 部分,trim 去 padding。caller 不传 changelog_id 时
    // 用老 4 列的第 3 列(index 2)作 fallback。
    //
    // **invariant**(R1 fix codex MED-3 / claude MED-4):**只用 oldCols[2] 作 changelog
    // fallback,严禁扩展用 oldCols[3+]**(后续列若含 escaped `\|` 会被 naive split 误切;
    // 当前 impl 仅读 oldCols[2]=changelog 列在 description 之前,不受 description escape
    // 影响,故安全)。任何未来扩展涉及 oldCols[3+] 必须先实现 escape-aware splitter。
    const oldCols = lines[targetIdx]
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    let newChangelog: string;
    if (changelogCell !== null) {
      newChangelog = changelogCell;
    } else if (oldCols.length >= 3 && oldCols[2]) {
      // 老 4 列 row: oldCols = [fileLink, status, changelog, description, ...]
      newChangelog = oldCols[2];
    } else {
      newChangelog = '—';
    }
    const newLine = `| ${fileLink} | completed | ${newChangelog} | ${description} |`;
    if (lines[targetIdx] === newLine && !headerUpgrade.upgraded) {
      // unchanged 仅当 row 自身相同 AND header 未升级两者都满足
      return { newContent: existingContent, action: 'unchanged' };
    }
    lines[targetIdx] = newLine;
    return { newContent: lines.join('\n'), action: 'updated' };
  }

  // case 3: 不含 plan_id 行 → append 4 列 row(若 header 已升级,workingContent 反映新 header)
  const appendLine = `| ${fileLink} | completed | ${changelogCell ?? '—'} | ${description} |`;
  const sep = workingContent.endsWith('\n') ? '' : '\n';
  return { newContent: workingContent + sep + appendLine + '\n', action: 'appended' };
}

/**
 * archive-plan-tool-ux-followup-20260515 R1 fix codex MED-1:detect 老 2 列 header
 * `| 文件 | 概要 |` + 紧接 separator `|---|---|`(或类似 2 列 separator)→ 替换为 4 列
 * canonical header `| 文件 | 状态 | 关联 changelog | 概要 |` + `|------|------|---------------|------|`。
 *
 * 保守 detect:必须 header 行只含「文件 / 概要」两列(允许 padding)+ 紧跟 2 列 separator
 * (避免误改用户自定义 header / 多列 header)。idempotent:已是 4 列 header 时 detect 不到 2 列
 * 模式即 no-op。
 *
 * 仅扫描首个匹配的 header(避免一份 INDEX 含多个 table 的极端 case 全部被改 — 不太合理)。
 *
 * **invariant(R2 codex LOW-1)**:本 helper 假设 INDEX **单 table**(本应用约定 plans/INDEX.md
 * 单一表格);多 table INDEX 边角下 target row 可能在第 2+ table,而本 helper 只升级首 table
 * header → 出现 4 列 row 挂 2 列 header。本应用不建议多 table INDEX 模式;后续如要支持需要
 * 「按 target row 找最近上方 table header」精细化升级。
 */
function upgradeIndexHeader(content: string): { content: string; upgraded: boolean } {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const headerMatch = lines[i].match(/^\|\s*文件\s*\|\s*概要\s*\|\s*$/);
    const sepMatch = lines[i + 1].match(/^\|[-:\s]+\|[-:\s]+\|\s*$/);
    if (headerMatch && sepMatch) {
      lines[i] = '| 文件 | 状态 | 关联 changelog | 概要 |';
      lines[i + 1] = '|------|------|---------------|------|';
      return { content: lines.join('\n'), upgraded: true };
    }
  }
  return { content, upgraded: false };
}

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
