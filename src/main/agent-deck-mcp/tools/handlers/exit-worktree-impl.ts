/**
 * exit_worktree handler 的实现层 — git / fs / DB 业务逻辑（plan
 * codex-handoff-team-alignment-20260518 P1 Step 1.3 / D2 + 不变量 5）。
 *
 * **抽出 impl 子模块的动机**：handler 入口（exit-worktree.ts）只做 deny external + caller
 * sid 反查 + 调本 impl + 包 ok/err。git / fs / DB 业务行为在这里，可以单测时 inject deps
 * mock 走纯 in-memory（与 archive-plan-impl / enter-worktree-impl 同款 DEFAULT_DEPS pattern）。
 *
 * **业务流程**（user CLAUDE.md §Step 4 完成 / 中止 cleanup 的 mcp 自动化）：
 *
 * 1. 反查 caller sessionRepo.cwd_release_marker（external sentinel 已在 handler 层 deny；
 *    impl 调用前 caller 必有效）
 * 2. 解析 worktree_path：args.worktree_path > sessionRepo.cwd_release_marker
 * 3. 校验 args.worktree_path vs marker 一致性：如 caller 同时传 override 但 marker 指向另一
 *    worktree → reject(stale state,不允许 caller 跨 worktree 操作)
 * 4. 解析 main_repo：`git -C <worktree_path> rev-parse --git-common-dir` → dirname
 *    (与 archive-plan-impl 同款)
 * 5. 如 action='remove':
 *    a. 预检 worktree 是 clean(或 args.discard_changes=true)：`git -C <worktree> status --porcelain` 输出空
 *    b. 解析 branch：`git -C <worktree> branch --show-current`
 *    c. `git -C <main_repo> worktree remove [--force] <worktree_path>`
 *    d. `git -C <main_repo> branch -D <branch>` (如 branch 有解析到 + branch != 'main' 等保护分支)
 * 6. clearCwdReleaseMarker(callerSid)（不变量 5）
 *
 * **action='keep' 语义**: 中途 hand-off 切会话场景, worktree 改动保留, marker 仍清(防 caller
 * 后续误判仍持有)。caller 下次接力 cold-start 用 builtin EnterWorktree(path: ...) 复用。
 *
 * **action='remove' 语义**: plan 完成或中止收口场景, worktree + branch 整片删, marker 清。
 *
 * 任一步失败立即返回 error（短路），不做部分回滚（git 操作不可逆）。
 *
 * **deps inject 模式**：默认实现走 Node 内置 + sessionRepo,test 通过传 `deps` 完全替换为
 * in-memory mock。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/** branch -D 保护清单 — 这些 branch 绝不允许 exit_worktree 自动删（即使 caller 显式 force）。 */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

export interface ExitWorktreeInput {
  callerSessionId: string;
  action: 'keep' | 'remove';
  worktreePathOverride?: string;
  discardChanges?: boolean;
}

export interface ExitWorktreeImplResult {
  worktreePath: string;
  action: 'keep' | 'remove';
  branchDeleted: boolean;
  worktreeRemoved: boolean;
  markerCleared: boolean;
}

export type ExitWorktreeError = { error: string; hint?: string };

export interface ExitWorktreeDeps {
  /** 跑 git 子命令；返回 stdout（trim）。失败抛 error。 */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** 文件 / 目录是否存在（true / false，不抛）。 */
  exists?: (p: string) => Promise<boolean>;
  /** sessionRepo.get(callerSid).cwdReleaseMarker 反查 seam。 */
  callerMarker?: (callerSid: string) => string | null;
  /** clearCwdReleaseMarker seam。 */
  clearCwdReleaseMarker?: (sid: string) => void;
}

const DEFAULT_DEPS: Required<ExitWorktreeDeps> = {
  runGit: async (args, cwd) => {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout.toString().trim();
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
  // callerMarker / clearCwdReleaseMarker 由 handler 显式注入(handler 端 import sessionRepo,
  // 避免 impl import 触发 electron.app load — 让本 impl test 走 deps inject 时不撞 electron)。
  // DEFAULT_DEPS 这两项故意抛 hint error,提示 caller 必须注入(silently no-op 会让 marker 不清
  // 静默失败,更危险)。
  callerMarker: (_sid: string) => {
    throw new Error(
      'exit-worktree-impl: deps.callerMarker not injected. Handler must provide a real sessionRepo wrapper.',
    );
  },
  clearCwdReleaseMarker: (_sid: string) => {
    throw new Error(
      'exit-worktree-impl: deps.clearCwdReleaseMarker not injected. Handler must provide a real sessionRepo wrapper.',
    );
  },
};

function isError(x: unknown): x is ExitWorktreeError {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { error?: unknown }).error === 'string'
  );
}

export async function exitWorktreeImpl(
  input: ExitWorktreeInput,
  depsOverride?: ExitWorktreeDeps,
): Promise<ExitWorktreeImplResult | ExitWorktreeError> {
  const deps: Required<ExitWorktreeDeps> = { ...DEFAULT_DEPS, ...depsOverride };

  // 1. 反查 marker
  const marker = deps.callerMarker(input.callerSessionId);

  // 2. resolve worktree_path
  const worktreePath = input.worktreePathOverride ?? marker;
  if (!worktreePath) {
    return {
      error: `cannot resolve worktree_path: caller has no cwd_release_marker and no args.worktree_path override`,
      hint: `exit_worktree needs to know which worktree to operate on. Either pass args.worktree_path explicitly, or call enter_worktree first to set the marker.`,
    };
  }

  // 3. 校验 args override vs marker 一致性
  if (input.worktreePathOverride && marker && marker !== input.worktreePathOverride) {
    return {
      error: `args.worktree_path (${input.worktreePathOverride}) does not match caller marker (${marker})`,
      hint: `Cross-worktree exit is not allowed (caller holds marker for a different worktree). Resolve by: (a) call exit_worktree without args.worktree_path to operate on marker's worktree, or (b) clear marker by calling enter_worktree → exit_worktree on the marker's worktree first.`,
    };
  }

  // 4. 解析 main_repo（用 git-common-dir 在 worktree 内查 main repo）
  if (!(await deps.exists(worktreePath))) {
    // worktree 已被手工删 — 仍清 marker 让 caller 不再持过期标记。
    // 不视为 error(idempotent 收尾)。
    if (marker) {
      try {
        deps.clearCwdReleaseMarker(input.callerSessionId);
      } catch {
        // clear 失败也不阻塞 — caller 仍能下次 enter_worktree 重置 marker
      }
    }
    return {
      worktreePath,
      action: input.action,
      branchDeleted: false,
      worktreeRemoved: false,
      markerCleared: true,
    };
  }

  let mainRepo: string;
  try {
    const gitCommonDir = await deps.runGit(['rev-parse', '--git-common-dir'], worktreePath);
    const commonDirAbs = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(worktreePath, gitCommonDir);
    mainRepo = path.dirname(commonDirAbs);
  } catch (e) {
    return {
      error: `git rev-parse --git-common-dir failed in worktree ${worktreePath}: ${(e as Error).message}`,
      hint: `worktree_path "${worktreePath}" is not a valid git worktree (or git not installed). Verify with \`git -C ${worktreePath} status\`.`,
    };
  }

  let branchDeleted = false;
  let worktreeRemoved = false;
  let branchName: string | null = null;

  if (input.action === 'remove') {
    // 5a. 预检 worktree clean（除非 discard_changes=true）
    if (!input.discardChanges) {
      try {
        const statusOut = await deps.runGit(['status', '--porcelain'], worktreePath);
        if (statusOut.trim().length > 0) {
          return {
            error: `worktree has uncommitted changes: ${statusOut.split('\n').slice(0, 3).join(' / ')}${statusOut.split('\n').length > 3 ? ' ...' : ''}`,
            hint: `exit_worktree refuses to remove worktree with uncommitted changes. Either commit / stash the changes first, or pass discard_changes=true to force (destructive, you will lose those changes).`,
          };
        }
      } catch (e) {
        return {
          error: `git status --porcelain failed in worktree: ${(e as Error).message}`,
        };
      }
    }

    // 5b. 解析 branch（用于 5d 删 branch）
    try {
      const out = await deps.runGit(['branch', '--show-current'], worktreePath);
      branchName = out.trim() || null;
    } catch {
      // 罕见 detached HEAD / git 版本太老 — 不阻塞 worktree remove
      branchName = null;
    }

    // 5c. git worktree remove
    try {
      const removeArgs = input.discardChanges
        ? ['worktree', 'remove', '--force', worktreePath]
        : ['worktree', 'remove', worktreePath];
      await deps.runGit(removeArgs, mainRepo);
      worktreeRemoved = true;
    } catch (e) {
      return {
        error: `git worktree remove failed: ${(e as Error).message}`,
        hint: `git worktree remove ${input.discardChanges ? '--force ' : ''}${worktreePath} (in ${mainRepo}) failed. Common causes: worktree locked / nested git operation in progress / fs permission. Verify with \`git -C ${mainRepo} worktree list\`.`,
      };
    }

    // 5d. git branch -D（保护清单 + branch == null 跳过）
    if (branchName && !PROTECTED_BRANCHES.has(branchName)) {
      try {
        await deps.runGit(['branch', '-D', branchName], mainRepo);
        branchDeleted = true;
      } catch (e) {
        // 罕见(branch 不存在 / 别 worktree 还在用)— 不视为 fatal error,worktree 已删,
        // caller 仍能手工 `git branch -D` 清。warn 给 caller log 但 ok return。
        return {
          error: `worktree removed but git branch -D ${branchName} failed: ${(e as Error).message}`,
          hint: `worktree at ${worktreePath} was successfully removed, but the branch ${branchName} still exists. Manual cleanup: \`git -C ${mainRepo} branch -D ${branchName}\`.`,
        };
      }
    }
  }

  // 6. clearCwdReleaseMarker (action='keep' / 'remove' 都清)
  let markerCleared = false;
  try {
    deps.clearCwdReleaseMarker(input.callerSessionId);
    markerCleared = true;
  } catch (e) {
    // marker 清失败不视为 fatal — git 操作已完成,caller 下次 enter_worktree 会覆盖 marker。
    // 但仍返 error 让 caller 知道 DB 写失败(可能 SQLite locked / 测试 mock 错)。
    return {
      error: `${input.action === 'remove' ? 'worktree removed but ' : ''}clearCwdReleaseMarker failed: ${(e as Error).message}`,
      hint: `${input.action === 'remove' ? `worktree at ${worktreePath} (branch ${branchName ?? '<unknown>'}) was successfully removed, but ` : ''}the per-session cwd_release_marker DB clear failed. Manual recovery: call enter_worktree to reset marker, then exit_worktree to clean up.`,
    };
  }

  return {
    worktreePath,
    action: input.action,
    branchDeleted,
    worktreeRemoved,
    markerCleared,
  };
}

// 测试用：暴露 DEFAULT_DEPS 让 single-deps override case 仍 fallback 真实现
export const _internalDefaultDeps = DEFAULT_DEPS;
export const _internalIsError = isError;
