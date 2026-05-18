/**
 * enter_worktree handler 的实现层 — git / fs / frontmatter / DB 业务逻辑（plan
 * codex-handoff-team-alignment-20260518 P1 Step 1.3 / D2 + 不变量 5）。
 *
 * **抽出 impl 子模块的动机**：handler 入口（enter-worktree.ts）只做 deny external + caller
 * sid 反查 + 调本 impl + 包 ok/err。git / fs / frontmatter 的业务行为在这里，可以单测时
 * inject deps mock 走纯 in-memory（与 archive-plan-impl 同款 DEFAULT_DEPS pattern）。
 *
 * **业务流程**（user CLAUDE.md §Step 1 主路径 (b) 「Bash 显式 git worktree add」+ 不变量 5
 * setCwdReleaseMarker 的 mcp 自动化）：
 *
 * 1. 反查 caller sessionRepo.cwd 拿 caller cwd（external sentinel 已在 handler 层 deny；
 *    impl 调用前 caller cwd 必有效）
 * 2. 解析 main_repo：`git -C <caller-cwd> rev-parse --show-toplevel`
 * 3. 派生 worktree_path：args.worktree_path > `<main_repo>/.claude/worktrees/<plan_id>/`
 * 4. 派生 branch_name：固定 `worktree-<plan_id>`（与 user CLAUDE.md §Step 1 命名约定对齐）
 * 5. 解析 base commit（plan D2 优先级链）：
 *    args.base_commit > args.base_branch resolve to HEAD > plan frontmatter base_commit >
 *    plan frontmatter base_branch resolve to HEAD > main_repo HEAD
 * 6. 预检 worktree_path 不存在 + branch 不存在（避免静默 reuse 老 worktree / 重名 branch）
 * 7. `git -C <main_repo> worktree add -b <branch> <worktree_path> <base_commit>`
 * 8. setCwdReleaseMarker(callerSid, worktree_path)（不变量 5 — archive_plan 预检 4 态分流
 *    认得跨 adapter 路径）
 *
 * 任一步失败立即返回 error（短路），不做部分回滚（git 操作不可逆）。
 *
 * **deps inject 模式**：默认实现走 Node 内置 + sessionRepo（child_process.execFile + fs/promises +
 * os.homedir + sessionRepo.setCwdReleaseMarker），test 通过传 `deps` 完全替换为 in-memory mock。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { parseFrontmatter } from '@main/utils/frontmatter';
import { sessionRepo } from '@main/store/session-repo';

const execFileAsync = promisify(execFile);

export interface EnterWorktreeInput {
  planId: string;
  callerSessionId: string;
  /** Caller 显式 worktree_path 覆盖默认派生路径；不传走 `<main_repo>/.claude/worktrees/<planId>/`。 */
  worktreePathOverride?: string;
  /** plan D2 优先级链最高位：caller args.base_commit。 */
  baseCommitOverride?: string;
  /** plan D2 优先级链次位：caller args.base_branch（resolve to branch HEAD）。 */
  baseBranchOverride?: string;
  /** plan 文件 abs path（用于 frontmatter base fallback）；不传走 fallback 链 .claude/plans/ → plans/ → ~/.claude/plans/。 */
  planFilePathOverride?: string;
}

export type BaseSource =
  | 'arg-base-commit'
  | 'arg-base-branch'
  | 'frontmatter-base-commit'
  | 'frontmatter-base-branch'
  | 'head';

export interface EnterWorktreeImplResult {
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  baseSource: BaseSource;
  markerSet: boolean;
}

export type EnterWorktreeError = { error: string; hint?: string };

export interface EnterWorktreeDeps {
  /** 跑 git 子命令；返回 stdout（trim）。失败抛 error。 */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** 读文件 utf8。失败抛（典型 ENOENT）。 */
  readFile?: (filePath: string) => Promise<string>;
  /** 文件 / 目录是否存在（true / false，不抛）。 */
  exists?: (p: string) => Promise<boolean>;
  /** $HOME 路径。 */
  homedir?: () => string;
  /** sessionRepo.get(callerSid).cwd 反查 seam，方便单测注入虚拟 cwd 不需要 mock 整 sessionRepo。 */
  callerCwd?: (callerSid: string) => string | null;
  /** setCwdReleaseMarker seam，方便单测验证 marker 写入行为。 */
  setCwdReleaseMarker?: (sid: string, marker: string) => void;
}

const DEFAULT_DEPS: Required<EnterWorktreeDeps> = {
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
  homedir: () => os.homedir(),
  callerCwd: (sid) => sessionRepo.get(sid)?.cwd ?? null,
  setCwdReleaseMarker: (sid, marker) => sessionRepo.setCwdReleaseMarker(sid, marker),
};

function isError(x: unknown): x is EnterWorktreeError {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { error?: unknown }).error === 'string'
  );
}

/**
 * fallback 链解 plan 文件路径（与 archive-plan-impl 同款）：
 * 显式 override > <main-repo>/.claude/plans/<id>.md > <main-repo>/plans/<id>.md > ~/.claude/plans/<id>.md
 * 返回首个存在的路径；都不存在返 null（frontmatter base fallback 跳过走 HEAD）。
 */
async function resolvePlanFilePath(
  input: EnterWorktreeInput,
  mainRepo: string,
  deps: Required<EnterWorktreeDeps>,
): Promise<string | null> {
  const candidates: string[] = [];
  if (input.planFilePathOverride) candidates.push(input.planFilePathOverride);
  candidates.push(path.join(mainRepo, '.claude', 'plans', `${input.planId}.md`));
  candidates.push(path.join(mainRepo, 'plans', `${input.planId}.md`));
  candidates.push(path.join(deps.homedir(), '.claude', 'plans', `${input.planId}.md`));
  for (const c of candidates) {
    if (await deps.exists(c)) return c;
  }
  return null;
}

/**
 * resolve base commit per plan D2 priority chain。返回 { baseCommit, baseSource } 或 error。
 * - args.base_commit  highest, return as-is (assume valid SHA hex per zod refine)
 * - args.base_branch: `git rev-parse <branch>` to commit; fail → error short-circuit
 * - frontmatter.base_commit: read plan file fm; if set, return
 * - frontmatter.base_branch: read plan file fm; if set, `git rev-parse` to commit
 * - head (default): `git rev-parse HEAD` in main_repo
 */
async function resolveBaseCommit(
  input: EnterWorktreeInput,
  mainRepo: string,
  deps: Required<EnterWorktreeDeps>,
): Promise<{ baseCommit: string; baseSource: BaseSource } | EnterWorktreeError> {
  // 1. args.base_commit highest
  if (input.baseCommitOverride) {
    return { baseCommit: input.baseCommitOverride, baseSource: 'arg-base-commit' };
  }
  // 2. args.base_branch
  if (input.baseBranchOverride) {
    try {
      const baseCommit = await deps.runGit(['rev-parse', input.baseBranchOverride], mainRepo);
      if (!baseCommit) {
        return {
          error: `git rev-parse ${input.baseBranchOverride} returned empty in ${mainRepo}`,
        };
      }
      return { baseCommit, baseSource: 'arg-base-branch' };
    } catch (e) {
      return {
        error: `git rev-parse ${input.baseBranchOverride} failed: ${(e as Error).message}`,
        hint: `args.base_branch must reference an existing branch in ${mainRepo}. Verify with \`git -C ${mainRepo} branch --list\`.`,
      };
    }
  }
  // 3. frontmatter base_commit / base_branch
  const planFilePath = await resolvePlanFilePath(input, mainRepo, deps);
  if (planFilePath) {
    try {
      const planContent = await deps.readFile(planFilePath);
      const fm = parseFrontmatter(planContent);
      const fmBaseCommit = typeof fm.base_commit === 'string' ? fm.base_commit.trim() : '';
      const fmBaseBranch = typeof fm.base_branch === 'string' ? fm.base_branch.trim() : '';
      if (fmBaseCommit.length >= 7) {
        return { baseCommit: fmBaseCommit, baseSource: 'frontmatter-base-commit' };
      }
      if (fmBaseBranch.length > 0) {
        try {
          const baseCommit = await deps.runGit(['rev-parse', fmBaseBranch], mainRepo);
          if (baseCommit) {
            return { baseCommit, baseSource: 'frontmatter-base-branch' };
          }
        } catch {
          // frontmatter base_branch 解析失败不算 error，fallback 走 HEAD（与 args.base_branch 严格不同：
          // args 是 caller 显式传必须 valid；frontmatter 是 best-effort 软约束）
        }
      }
    } catch {
      // plan 文件不可读不算 error（与 args.base_branch 严格不同），fallback 走 HEAD
    }
  }
  // 5. head (default)
  try {
    const baseCommit = await deps.runGit(['rev-parse', 'HEAD'], mainRepo);
    if (!baseCommit) {
      return { error: `git rev-parse HEAD returned empty in ${mainRepo}` };
    }
    return { baseCommit, baseSource: 'head' };
  } catch (e) {
    return {
      error: `git rev-parse HEAD failed in main repo ${mainRepo}: ${(e as Error).message}`,
      hint: `main_repo "${mainRepo}" may not be a valid git repo or HEAD is detached / unborn (no commits). Verify with \`git -C ${mainRepo} log -1\`.`,
    };
  }
}

export async function enterWorktreeImpl(
  input: EnterWorktreeInput,
  depsOverride?: EnterWorktreeDeps,
): Promise<EnterWorktreeImplResult | EnterWorktreeError> {
  const deps: Required<EnterWorktreeDeps> = { ...DEFAULT_DEPS, ...depsOverride };

  // 1. 反查 caller cwd
  const callerCwd = deps.callerCwd(input.callerSessionId);
  if (!callerCwd) {
    return {
      error: `caller session ${input.callerSessionId} has no cwd (session not found or cwd column is null)`,
      hint: `enter_worktree needs caller cwd to derive main_repo via \`git rev-parse --show-toplevel\`. Make sure caller_session_id references an active session managed by Agent Deck.`,
    };
  }

  // 2. main_repo
  let mainRepo: string;
  try {
    mainRepo = await deps.runGit(['rev-parse', '--show-toplevel'], callerCwd);
  } catch (e) {
    return {
      error: `git rev-parse --show-toplevel failed in caller cwd ${callerCwd}: ${(e as Error).message}`,
      hint: `caller cwd "${callerCwd}" is not inside a git repository. enter_worktree requires caller to operate from within a git working tree. Verify with \`git -C ${callerCwd} rev-parse --show-toplevel\`.`,
    };
  }
  if (!mainRepo) {
    return { error: `git rev-parse --show-toplevel returned empty in ${callerCwd}` };
  }

  // 3. worktree_path
  const worktreePath =
    input.worktreePathOverride ??
    path.join(mainRepo, '.claude', 'worktrees', input.planId);

  // 4. branch_name
  const branchName = `worktree-${input.planId}`;

  // 5. base resolution
  const baseResult = await resolveBaseCommit(input, mainRepo, deps);
  if (isError(baseResult)) return baseResult;
  const { baseCommit, baseSource } = baseResult;

  // 6. 预检 worktree_path / branch 不存在
  if (await deps.exists(worktreePath)) {
    return {
      error: `worktree path already exists: ${worktreePath}`,
      hint: `enter_worktree refuses silent reuse of an existing path. Either pass a different worktree_path, manually \`git worktree remove ${worktreePath}\`, or call exit_worktree with action="remove" first.`,
    };
  }
  // git branch 存在性检查走 git for-each-ref（exit-code 友好，比 rev-parse fail 噪声小）
  let branchExists = false;
  try {
    const out = await deps.runGit(
      ['for-each-ref', '--format=%(refname:short)', `refs/heads/${branchName}`],
      mainRepo,
    );
    branchExists = out.trim() === branchName;
  } catch {
    // for-each-ref 罕见失败（典型 main_repo 不是 git repo —— 但 step 2 已校验过），fallback false 让 step 7 撞 git 错误
  }
  if (branchExists) {
    return {
      error: `branch already exists: ${branchName}`,
      hint: `enter_worktree refuses silent reuse of an existing branch. Either manually \`git -C ${mainRepo} branch -D ${branchName}\`, or use a different plan_id.`,
    };
  }

  // 7. git worktree add
  try {
    await deps.runGit(
      ['worktree', 'add', '-b', branchName, worktreePath, baseCommit],
      mainRepo,
    );
  } catch (e) {
    return {
      error: `git worktree add failed: ${(e as Error).message}`,
      hint: `git worktree add -b ${branchName} ${worktreePath} ${baseCommit} (in ${mainRepo}) failed. Common causes: worktree_path parent dir not writable / base_commit not in repo / branch already exists despite step 6 check (race). Verify with the same command manually.`,
    };
  }

  // 8. setCwdReleaseMarker
  let markerSet = false;
  try {
    deps.setCwdReleaseMarker(input.callerSessionId, worktreePath);
    markerSet = true;
  } catch (e) {
    // marker 写失败不阻塞 ok return —— worktree 已建好，caller 仍能用 builtin claude
    // ExitWorktree 收尾。warn 留给 caller log，让 caller 知道 archive_plan 预检 4 态可能走错路径。
    return {
      error: `worktree created but setCwdReleaseMarker failed: ${(e as Error).message}`,
      hint: `worktree at ${worktreePath} (branch ${branchName}) was successfully created, but the per-session cwd_release_marker DB write failed. archive_plan preflight 4-state dispatch may misclassify this caller as "in worktree but no marker" (reject). Manual recovery: call exit_worktree to clean up the marker state, then retry enter_worktree.`,
    };
  }

  return { worktreePath, branchName, baseCommit, baseSource, markerSet };
}

// 测试用：暴露 DEFAULT_DEPS 让 single-deps override case 仍 fallback 真实现
export const _internalDefaultDeps = DEFAULT_DEPS;
export const _internalIsError = isError;
