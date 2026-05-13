/**
 * hand_off_session handler 的实现层 — plan 文件路径 resolve + frontmatter parse +
 * status 校验 + cold-start prompt 构造（plan mcp-bug-and-feature-batch-20260513
 * Phase 4b Step 4b.2）。
 *
 * **抽 impl 子模块的动机**：与 archive-plan-impl 同款 — handler 入口（hand-off-session.ts）
 * 只做 deny external + caller 反查 + 调本 impl 拿到 resolved 上下文 + 调 spawnSessionHandler
 * 完成 spawn + 包 ok/err。fs / git / frontmatter 解析逻辑在这里，可单测时 inject deps mock
 * 走纯 in-memory，不需 vi.mock node 内置。
 *
 * **业务流程**：
 *
 * 1. 解析 plan 文件路径：显式 planFilePathOverride > caller cwd 反查 main-repo →
 *    `<main-repo>/.claude/plans/<plan_id>.md` > `~/.claude/plans/<plan_id>.md`
 * 2. 读 plan + parseFrontmatter，校验 frontmatter 含 `worktree_path`
 * 3. 校验 plan status === 'in_progress'（拒 completed / abandoned / 缺 status）
 * 4. 构造 cold-start prompt：基础形式 `按 <plan-abs-path> 接力`；含 phase_label 时附
 *    `（Phase: <label>）` 后缀
 * 5. 返回 resolved 上下文（planFilePath / worktreePath / coldStartPrompt），handler
 *    拿这个组装 spawn_session args 完成实际 spawn
 *
 * **deps inject 模式**：默认实现走 Node 内置（child_process.execFile + fs/promises +
 * os.homedir + process.cwd），test 通过传 `deps` 参数完全替换为 in-memory mock。
 * 与 archive-plan-impl 完全同款。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { parseFrontmatter } from '@main/utils/frontmatter';

const execFileAsync = promisify(execFile);

export interface HandOffSessionInput {
  planId: string;
  /** 可选 phase_label，含值时附 prompt 后缀 `（Phase: <label>）` */
  phaseLabel?: string;
  /** 显式 plan 文件路径，覆盖 fallback */
  planFilePathOverride?: string;
}

/**
 * impl 解析后返回的「准备好可以 spawn」上下文。handler 拿这个 + 用户传的
 * adapter/team_name/permission_mode/cwd_override 等组装 spawn_session args。
 */
export interface HandOffSessionResolved {
  /** 实际命中的 plan 文件绝对路径（默认 fallback / 显式 override 都解析到这里） */
  planFilePath: string;
  /** plan frontmatter 里的 worktree_path（绝对路径） */
  worktreePath: string;
  /** 构造好的 cold-start prompt（含 phase_label 后缀的最终形态） */
  coldStartPrompt: string;
  /** plan frontmatter 里的 base_branch（如果有，给 caller 透传 archive_plan 用） */
  baseBranch: string | null;
  /**
   * caller cwd 反查 git common-dir 得到的 main repo 绝对路径，**handler 用作 K2 spawn 默认 cwd**
   * （CHANGELOG_99 cwd 失效根治）。优先级：
   * 1. caller cwd → `git rev-parse --git-common-dir` 反查（impl 现有机制）
   * 2. 反查失败 → 从 worktreePath 启发式反推 `^(.+)/\.claude/worktrees/[^/]+/?$` 取捕获组 1
   * 3. 全失败 → null（handler 兜底降级到 worktreePath 保持原行为）
   *
   * 为什么需要这个？历史上 K2 default cwd = worktreePath 让新 session 的 sessionRepo.cwd
   * 一开始就是 worktree 路径；archive_plan / git worktree remove 删 worktree 后 sessionRepo.cwd
   * 指向已删目录，recoverer 重启 SDK 撞「Path does not exist」弯绕错误链。改 default = mainRepo
   * 后新 session 行为与 EnterWorktree 模式对齐：sessionRepo.cwd 永远是 main repo，process.cwd
   * 经 cold-start prompt 的 EnterWorktree(path: ...) 进 worktree 干活；worktree 删了 sessionRepo
   * cwd 仍 valid。
   */
  mainRepo: string | null;
}

export type HandOffSessionError = { error: string; hint?: string };

export interface HandOffSessionDeps {
  /** 跑 git 子命令；返回 stdout（trim）。失败抛 error。仅用于反查 main-repo。 */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** 读文件 utf8。失败抛（典型 ENOENT）。 */
  readFile?: (filePath: string) => Promise<string>;
  /** 文件 / 目录是否存在（true / false，不抛）。 */
  exists?: (p: string) => Promise<boolean>;
  /** 当前进程 cwd。 */
  cwd?: () => string;
  /** $HOME 路径。 */
  homedir?: () => string;
}

const DEFAULT_DEPS: Required<HandOffSessionDeps> = {
  runGit: async (args, cwd) => {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.toString().trim();
  },
  readFile: async (p) => fs.readFile(p, 'utf8'),
  exists: async (p) => {
    try {
      const _: Stats = await fs.stat(p);
      void _;
      return true;
    } catch {
      return false;
    }
  },
  cwd: () => process.cwd(),
  homedir: () => os.homedir(),
};

function isError(x: HandOffSessionResolved | HandOffSessionError): x is HandOffSessionError {
  return (x as HandOffSessionError).error !== undefined;
}

export async function handOffSessionImpl(
  input: HandOffSessionInput,
  depsOverride?: HandOffSessionDeps,
): Promise<HandOffSessionResolved | HandOffSessionError> {
  const deps: Required<HandOffSessionDeps> = { ...DEFAULT_DEPS, ...depsOverride };

  // 0. 反查 mainRepo（CHANGELOG_99 cwd 失效根治）：单次 git rev-parse，给 plan 文件 fallback
  // + handler default cwd 共享。优先级：caller cwd 反查 → 校验完 worktreePath 后启发式反推 → null。
  // 不在主流程末尾再重复 runGit（保持 git 子命令调用次数稳定，避免 test 断言炸）。
  const callerCwd = deps.cwd();
  let mainRepo: string | null = null;
  try {
    const gitCommonDir = await deps.runGit(['rev-parse', '--git-common-dir'], callerCwd);
    const commonDirAbs = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(callerCwd, gitCommonDir);
    mainRepo = path.dirname(commonDirAbs);
  } catch {
    // caller cwd 不是 git repo（如 Electron main process cwd = `/`）→ 留 null，等校验完
    // worktreePath 再启发式反推
    mainRepo = null;
  }

  // 1. 解析 plan 文件路径：显式 > main-repo 反查 > user-global
  let planFilePath: string;
  if (input.planFilePathOverride) {
    if (!(await deps.exists(input.planFilePathOverride))) {
      return {
        error: `plan_file_path override does not exist: ${input.planFilePathOverride}`,
      };
    }
    planFilePath = input.planFilePathOverride;
  } else {
    const projectLocal = mainRepo
      ? path.join(mainRepo, '.claude', 'plans', `${input.planId}.md`)
      : null;
    const userGlobal = path.join(deps.homedir(), '.claude', 'plans', `${input.planId}.md`);

    if (projectLocal && (await deps.exists(projectLocal))) {
      planFilePath = projectLocal;
    } else if (await deps.exists(userGlobal)) {
      planFilePath = userGlobal;
    } else {
      const triedLines = projectLocal
        ? `Tried: ${projectLocal}\n       ${userGlobal}`
        : `Tried: ${userGlobal} (caller cwd is not a git repo, skipped <main-repo>/.claude/plans/ lookup)`;
      return {
        error: `plan file not found at any default location`,
        hint: `${triedLines}\nPass plan_file_path explicitly to override, or check that plan_id "${input.planId}" matches the file stem.`,
      };
    }
  }

  // 2. 读 plan + parseFrontmatter
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
      hint: 'plan file must start with `---\\n<key>: <value>\\n---\\n` block (e.g. `worktree_path: /...` and `status: in_progress`).',
    };
  }

  // 3. 校验 worktree_path 字段
  const worktreePath = fm.worktree_path;
  if (!worktreePath || worktreePath.length === 0) {
    return {
      error: `plan frontmatter missing required field: worktree_path`,
      hint: `hand_off_session (plan-driven mode) needs worktree_path to set cwd for the new SDK session. Edit ${planFilePath} frontmatter to include \`worktree_path: <abs-path>\`.`,
    };
  }
  if (!path.isAbsolute(worktreePath)) {
    return {
      error: `plan frontmatter worktree_path must be absolute: ${worktreePath}`,
    };
  }

  // 4. 校验 status === 'in_progress'
  const status = fm.status;
  if (status !== 'in_progress') {
    if (status === 'completed') {
      return {
        error: `plan status is "completed" — cannot start next session for archived plan`,
        hint: `Use hand_off_session (plan-driven mode) only for in-progress plans. If you need to resume work on this plan, manually edit frontmatter status back to in_progress.`,
      };
    }
    if (status === 'abandoned') {
      return {
        error: `plan status is "abandoned" — cannot start next session`,
        hint: `Abandoned plans are not meant to be resumed. Create a new plan if you want to restart this work.`,
      };
    }
    return {
      error: `plan status must be "in_progress" but got "${status ?? '<missing>'}"`,
      hint: `Edit ${planFilePath} frontmatter to set \`status: in_progress\` before calling hand_off_session (plan-driven mode).`,
    };
  }

  // 5. mainRepo 启发式 fallback（CHANGELOG_99）：caller cwd 反查 git common-dir 失败时
  // （如 Electron main process cwd = `/`），从 worktreePath 启发式反推。
  // 约定路径：`<main-repo>/.claude/worktrees/<plan-id>` → 取 .claude/worktrees/ 之前部分。
  // 用户用了非约定路径时启发式 miss → 仍 null → handler 兜底降级到 worktreePath（保持
  // 原行为，保证不崩）。
  if (mainRepo === null) {
    const m = worktreePath.match(/^(.+)\/\.claude\/worktrees\/[^/]+\/?$/);
    if (m) mainRepo = m[1];
  }

  // 6. 构造 cold-start prompt
  const baseBranch = fm.base_branch ?? null;
  const baseLine = `按 ${planFilePath} 接力`;
  const coldStartPrompt = input.phaseLabel
    ? `${baseLine}（Phase: ${input.phaseLabel}）`
    : baseLine;

  return {
    planFilePath,
    worktreePath,
    coldStartPrompt,
    baseBranch,
    mainRepo,
  };
}

// 测试 helper export
export { isError as _isHandOffSessionError };
