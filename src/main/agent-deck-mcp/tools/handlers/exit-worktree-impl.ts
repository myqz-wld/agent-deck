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
 * 2. 解析 worktreePath：args.worktreePath > sessionRepo.cwd_release_marker
 * 3. 校验 args.worktreePath vs marker 一致性：如 caller 同时传 override 但 marker 指向另一
 *    worktree → reject(stale state,不允许 caller 跨 worktree 操作)
 * 4. 解析 main_repo：`git -C <worktreePath> rev-parse --git-common-dir` → dirname
 *    (与 archive-plan-impl 同款)
 * 5. 如 action='remove':
 *    a. 预检 worktree 是 clean(或 args.discardChanges=true)：`git -C <worktree> status --porcelain` 输出空
 *    b. 解析 branch：`git -C <worktree> branch --show-current`
 *    c. `git -C <main_repo> worktree remove [--force] <worktreePath>`
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

import * as path from 'node:path';

import {
  runGitDefault,
  existsDefault,
  realpathDefault,
} from './_shared/default-impl-deps';

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

export type ExitWorktreeError = {
  error: string;
  hint?: string;
  /**
   * plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.8 (L2 claude B LOW-1):
   * markerCleared 语义在 happy / early-return path 对称。partial-success error 路径也透传
   * markerCleared 让 caller 知道 marker DB 状态(避免 caller 重试时仍持 stale marker)。
   * - true: marker 已清(典型 step 4 worktree 不存在 partial-success / step 5d branch 删失败但
   *   worktree 已删 / step 4 .git 损坏 action='keep' 路径)
   * - false: marker 未清(worktree dirty 拦下 / cross-worktree 不允许 release / git worktree remove
   *   失败保留 caller 仍在 worktree 内的状态 / step 6 clear marker 自身失败)
   * - undefined: error 路径未涉及 marker 操作(早期 input 校验失败等),caller 应当 marker 状态未知
   */
  markerCleared?: boolean;
};

export interface ExitWorktreeDeps {
  /** 跑 git 子命令；返回 stdout（trim）。失败抛 error。 */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  /** 文件 / 目录是否存在（true / false，不抛）。 */
  exists?: (p: string) => Promise<boolean>;
  /**
   * P5 Round 1 reviewer-claude MED-2 修法 (realpath alignment with archive-plan-impl):
   * args.worktreePath 与 marker 字面比较前必须 realpath 解 symlink 才与 archive_plan 4 态对称。
   * macOS firmlink (/var → /private/var) / 用户软链 worktree 路径 / cross-device 同步走不同符号链
   * 路径时 caller 显式传 args.worktreePath 解析后形与 marker literal 不字面相等会错报 cross-worktree
   * reject。realpath 失败 fallback 字面（与 archive-plan-impl §step 4 marker 处理同款,极端 edge case
   * 字面比较）。
   */
  realpath?: (p: string) => Promise<string>;
  /** sessionRepo.get(callerSid).cwdReleaseMarker 反查 seam。 */
  callerMarker?: (callerSid: string) => string | null;
  /** clearCwdReleaseMarker seam。 */
  clearCwdReleaseMarker?: (sid: string) => void;
}

const DEFAULT_DEPS: Required<ExitWorktreeDeps> = {
  runGit: runGitDefault,
  exists: existsDefault,
  realpath: realpathDefault,
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

/**
 * Follow-up #5: 去尾斜杠归一化。realpath fallback(realpath 失败退化字面)+ marker 反查路径可能
 * 一端带尾斜杠(`/path/`)另一端不带(`/path`),字面 `!==` 误报 cross-worktree reject。realpath
 * 成功时一般已无尾斜杠(fs.realpath 规整),但 fallback 字面路径 / caller 显式传带尾斜杠的
 * worktreePath / marker 历史写入带尾斜杠时需归一化。保留根 `/`(replace(/\/+$/,'') 对单 `/`
 * 会清成空串,故空串时还原 `/`)。
 */
function stripTrailingSlash(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

export async function exitWorktreeImpl(
  input: ExitWorktreeInput,
  depsOverride?: ExitWorktreeDeps,
): Promise<ExitWorktreeImplResult | ExitWorktreeError> {
  const deps: Required<ExitWorktreeDeps> = { ...DEFAULT_DEPS, ...depsOverride };

  // 1. 反查 marker
  const marker = deps.callerMarker(input.callerSessionId);

  // 2. resolve worktreePath
  const worktreePath = input.worktreePathOverride ?? marker;
  if (!worktreePath) {
    return {
      error: `cannot resolve worktreePath: caller has no cwd_release_marker and no args.worktreePath override`,
      hint: `exit_worktree needs to know which worktree to operate on. Either pass args.worktreePath explicitly, or call enter_worktree first to set the marker.`,
    };
  }

  // 3. 校验 args override vs marker 一致性
  // P5 Round 1 reviewer-claude MED-2 修法 (realpath alignment): 字面比较升级为 realpath 解 symlink 后
  // 比较,与 archive-plan-impl §step 4 marker 处理对称。两边都解 symlink — args 端 macOS firmlink
  // /var → /private/var,marker 端用户跨会话 marker 走不同符号链路径 → 字面 !== 但 realpath ===
  // 时旧实现错报 cross-worktree reject。realpath 失败 fallback 字面（极端 edge case 退化）。
  //
  // Follow-up #5: realpath 后再去尾斜杠归一化(stripTrailingSlash)。realpath fallback 退化字面时
  // 一端带尾斜杠(`/path/`)另一端不带(`/path`)会误报 cross-worktree reject(realpath 成功一般已
  // 规整尾斜杠,但 fallback 字面 / caller 显式传带尾斜杠 worktreePath / marker 历史带尾斜杠时需归一化)。
  if (input.worktreePathOverride && marker) {
    let argReal = input.worktreePathOverride;
    let markerReal = marker;
    try {
      argReal = await deps.realpath(input.worktreePathOverride);
    } catch {
      /* fallback 字面 */
    }
    try {
      markerReal = await deps.realpath(marker);
    } catch {
      /* fallback 字面 */
    }
    if (stripTrailingSlash(argReal) !== stripTrailingSlash(markerReal)) {
      return {
        error: `args.worktreePath (${input.worktreePathOverride}) does not match caller marker (${marker})`,
        hint: `Cross-worktree exit is not allowed (caller holds marker for a different worktree). Resolve by: (a) call exit_worktree without args.worktreePath to operate on marker's worktree, or (b) clear marker by calling enter_worktree → exit_worktree on the marker's worktree first.`,
      };
    }
  }

  // 4. 解析 main_repo（用 git-common-dir 在 worktree 内查 main repo）
  if (!(await deps.exists(worktreePath))) {
    // worktree 已被手工删 — 仍清 marker 让 caller 不再持过期标记。
    // 不视为 error(idempotent 收尾)。
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.8 修法 (B-MED-2 claude):
    // 旧版 catch 默默吞 clear failure 仍 return markerCleared:true → caller 看到「已清」错觉
    // 但 marker DB 仍脏,下次再调任何路径触发 marker 校验仍命中 stale。修法:catch return
    // error 与 step 6 happy path (L260+ clearCwdReleaseMarker throw → 上层 try/catch return error)
    // 对称,partial-success 显式报告给 caller 决定如何 recover。
    let markerCleared = false;
    if (marker) {
      try {
        deps.clearCwdReleaseMarker(input.callerSessionId);
        markerCleared = true;
      } catch (e) {
        // plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.8: error 路径加 markerCleared
        // 字段(false 表示 marker DB clear 失败 — 与 happy/partial-success 对称)
        return {
          error: `worktree was already removed but clearCwdReleaseMarker failed: ${(e as Error).message}`,
          hint: `worktree at ${worktreePath} no longer exists. Marker DB clear failed (partial-success). Manual recovery: call enter_worktree to reset marker, then exit_worktree.`,
          markerCleared: false,
        };
      }
    }
    return {
      worktreePath,
      action: input.action,
      branchDeleted: false,
      worktreeRemoved: false,
      markerCleared,
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
    // plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.7 + 5.8 (M11 codex B MED-3 + L2)：
    // .git 损坏时 action='keep' 路径仍能清 marker(纯本地状态清理,不依赖 git ops):
    // - action='keep' 不删 worktree 不删 branch,仅清 caller per-session marker → 即使 .git 损坏
    //   也能 idempotent 收尾(让下次 archive_plan 4 态预检不撞 stale marker)
    // - action='remove' 必需 git worktree remove + branch -D,git 通讯断层无法 fallback → 仍 reject
    // markerCleared 字段透传 caller 让其知道 marker DB 状态(plan §5.8 happy/early-return 对称)
    const errMsg = (e as Error).message;
    if (input.action === 'keep') {
      let markerCleared = false;
      if (marker) {
        try {
          deps.clearCwdReleaseMarker(input.callerSessionId);
          markerCleared = true;
        } catch (markerErr) {
          return {
            error: `partial-success: git rev-parse --git-common-dir failed in worktree ${worktreePath} (${errMsg}); .git metadata may be corrupt. action='keep' attempted to clear caller marker but clearCwdReleaseMarker also failed: ${(markerErr as Error).message}`,
            hint: `worktree directory at ${worktreePath} exists but its .git metadata is unreadable AND marker DB clear failed. Manual recovery: (a) check worktree.git existence with \`ls -la ${worktreePath}/.git\`; if file present but corrupt, repair via main repo \`git worktree repair\`; (b) restart Agent Deck to retry marker clear. Marker DB still holds stale marker for ${worktreePath}.`,
            markerCleared: false,
          };
        }
      }
      return {
        error: `partial-success: git rev-parse --git-common-dir failed in worktree ${worktreePath}: ${errMsg}; .git metadata may be corrupt`,
        hint: `worktree directory at ${worktreePath} exists but its .git metadata is unreadable. action='keep' completed marker cleanup (markerCleared=${markerCleared}) so caller no longer holds stale marker for this worktree. Manual recovery: check \`ls -la ${worktreePath}/.git\`; if file present but corrupt, repair via \`git -C <main-repo> worktree repair\` or simply re-create the worktree.`,
        markerCleared,
      };
    }
    // action='remove' 路径: git ops 必需 .git 通讯,无法 fallback。marker 不清(worktree 仍在,
    // caller 可能仍引用)。
    return {
      error: `git rev-parse --git-common-dir failed in worktree ${worktreePath}: ${errMsg}`,
      hint: `worktreePath "${worktreePath}" is not a valid git worktree (or git not installed). action='remove' requires intact .git metadata for \`git worktree remove\` + \`git branch -D\`. Verify with \`git -C ${worktreePath} status\`. If .git is corrupt, manually clean up via \`rm -rf ${worktreePath}\` + \`git -C <main-repo> worktree prune\` then retry exit_worktree({ action: 'keep' }) to clear marker. Marker DB unchanged.`,
      markerCleared: false,
    };
  }

  let branchDeleted = false;
  let worktreeRemoved = false;
  let branchName: string | null = null;

  if (input.action === 'remove') {
    // 5a. 预检 worktree clean（除非 discardChanges=true）
    if (!input.discardChanges) {
      try {
        const statusOut = await deps.runGit(['status', '--porcelain'], worktreePath);
        if (statusOut.trim().length > 0) {
          return {
            error: `worktree has uncommitted changes: ${statusOut.split('\n').slice(0, 3).join(' / ')}${statusOut.split('\n').length > 3 ? ' ...' : ''}`,
            hint: `exit_worktree refuses to remove worktree with uncommitted changes. Either commit / stash the changes first, or pass discardChanges=true to force (destructive, you will lose those changes).`,
          };
        }
      } catch (e) {
        return {
          error: `git status --porcelain failed in worktree: ${(e as Error).message}`,
        };
      }
    }

    // 5b. 解析 branch（用于 5c-pre 未合并预检 + 5d 删 branch）
    try {
      const out = await deps.runGit(['branch', '--show-current'], worktreePath);
      branchName = out.trim() || null;
    } catch {
      // 罕见 detached HEAD / git 版本太老 — 不阻塞 worktree remove
      branchName = null;
    }

    // 5c-pre. 未合并 commit 预检（REVIEW_72 MED — deep-review reviewer-codex ✅ + lead 实测）：
    // schema (schemas.ts:594) 承诺「discardChanges=false 时若 worktree 有 commits not on base
    // branch,tool refuses ... protects against accidentally losing work」。修前仅 5a 预检
    // uncommitted changes(working tree dirty),已 commit 但未合并的 commit 不在 5a 拦截范围 →
    // 先 `git worktree remove`(working tree clean 时 rc=0 成功删目录)再到 5d `git branch -d`
    // 才发现未合并 → worktree 目录已删但 return error,违反「refuse 保护工作」契约。
    //
    // **git 顺序硬约束**:不能在 worktree remove 之前先 `branch -d`(git 拒删 checked-out branch),
    // 所以删除顺序无法调换 → 必须在 remove **之前**独立预检未合并状态。`git merge-base
    // --is-ancestor <branch> HEAD`(在 main repo 跑)精确镜像 `git branch -d` 的 reachability 判定:
    // rc=0 = branch tip 可从 main repo HEAD 到达(已合并,删 worktree 安全);rc=1 = 有未合并 commit。
    //
    // **实测铁证**:worktree 内 commit 后 `git worktree remove`(clean tree)rc=0 删目录成功,随后
    // `git branch -d` rc=1 报 not fully merged 但 branch+commit 存活(可 `git branch -D` 恢复)。本
    // 预检让 discardChanges=false + 未合并 时**保留 worktree**让 caller 回去处理,兑现 schema 契约。
    // branch == null(detached HEAD) / protected branch 跳过预检(无对应 branch -d 删除动作)。
    if (!input.discardChanges && branchName && !PROTECTED_BRANCHES.has(branchName)) {
      let hasUnmergedCommits = false;
      try {
        // is-ancestor rc=0 → 已合并(merge-base 成功);非 0 throw → 未合并 / 错误
        await deps.runGit(['merge-base', '--is-ancestor', branchName, 'HEAD'], mainRepo);
      } catch {
        // rc=1(未合并)或 rc=128(罕见 git 错误)→ 保守视为有未合并 commit,refuse 保护工作。
        // 即使 is-ancestor 因非预期原因失败,保留 worktree 也比误删安全(caller 可显式 discardChanges=true)。
        hasUnmergedCommits = true;
      }
      if (hasUnmergedCommits) {
        return {
          error: `worktree branch "${branchName}" has commits not merged into HEAD — refusing to remove (discardChanges=false)`,
          hint: `exit_worktree refuses to remove a worktree whose branch has unmerged commits (protects against accidentally losing work — matches schema contract). worktree at ${worktreePath} is preserved so you can recover. Options: (a) merge / cherry-pick the unmerged commits into your base branch first, then retry exit_worktree; (b) call exit_worktree({ action: 'remove', worktreePath: '${worktreePath}', discardChanges: true }) to force remove (destructive, deletes worktree + branch with those commits); (c) keep the work: exit_worktree({ action: 'keep' }) leaves worktree + branch intact. Marker DB unchanged (caller still holds marker).`,
          markerCleared: false,
        };
      }
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

    // 5d. git branch -d / -D（保护清单 + branch == null 跳过）
    // P5 Round 1 reviewer-codex MED-4 修法 (discardChanges 也保护未合并 commit):
    // 旧实现无条件 `branch -D` 删未合并 commit,违反 schema "discardChanges=false 不丢 caller
    // 工作"契约(schema 描述含 "commits not on base branch")。
    // - discardChanges=false: 用 `git branch -d` (lowercase)只删已合并 branch,未合并撞 git error
    //   "branch is not fully merged" → impl 转 partial-success error 让 caller 决定 (commit / merge / 显式 force)
    // - discardChanges=true: 用 `git branch -D` 强制删 (caller 已显式接受 commit 丢失)
    if (branchName && !PROTECTED_BRANCHES.has(branchName)) {
      const branchDeleteFlag = input.discardChanges ? '-D' : '-d';
      try {
        await deps.runGit(['branch', branchDeleteFlag, branchName], mainRepo);
        branchDeleted = true;
      } catch (e) {
        // P5 Round 1 reviewer-claude MED-1 修法 (comment vs code 对齐):虽 worktree 已成功删,
        // branch -d/-D 失败仍 return error 让 caller 显式处理(silently ok 会让 caller 错以为
        // 完全清理,实际 branch 仍存在污染 list)。caller 拿到 hint 后手工 git branch -D。
        //
        // plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.6 + 5.8 (M10 codex B MED-2 + L2):
        // - error 第一行加 "partial-success" 前缀(让 caller 不读 hint 就知道是 partial vs full)
        // - 加 markerCleared 字段(worktree 已删 = caller 不再在 worktree 内 = 清 marker 防 stale)
        // - hint 已经含可执行 `git -C ${mainRepo} branch -D ${branchName}` 命令(M10 描述「改可执行」
        //   要求满足),isUnmerged 路径还多 (a)/(b)/(c) 三选项让 caller 选合适恢复方式
        const errMsg = (e as Error).message;
        const isUnmerged =
          !input.discardChanges && /not fully merged|not yet been merged/i.test(errMsg);
        // 尝试清 marker(worktree 已删,caller 不再在 worktree 内,清 marker 防 stale)
        let markerCleared = false;
        try {
          deps.clearCwdReleaseMarker(input.callerSessionId);
          markerCleared = true;
        } catch {
          // marker 清失败也不阻塞 partial-success error 返回(caller 已知 branch 有问题,
          // marker 清失败再加一层告知意义不大,让主诉求 branch 删失败先呈现)
        }
        return {
          error: `partial-success: worktree removed but git branch ${branchDeleteFlag} ${branchName} failed: ${errMsg}`,
          hint: isUnmerged
            ? `branch ${branchName} has commits not yet merged into base — refusing to delete (discardChanges=false). Options: (a) merge / cherry-pick the unmerged commits into your base branch first, then retry exit_worktree; (b) call exit_worktree({ action: 'remove', worktreePath: '${worktreePath}', discardChanges: true }) to force delete (destructive, you will lose those commits); (c) manually clean up: \`git -C ${mainRepo} branch -D ${branchName}\`. Marker DB cleared (markerCleared=${markerCleared}) so caller no longer holds stale marker for ${worktreePath}.`
            : `worktree at ${worktreePath} was successfully removed, but the branch ${branchName} still exists (this is partial-success not full failure). Manual cleanup: \`git -C ${mainRepo} branch -D ${branchName}\`. Common causes: branch already deleted by another tool / branch checked out in another worktree. Marker DB cleared (markerCleared=${markerCleared}).`,
          markerCleared,
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
    // P5 Round 1 reviewer-claude MED-1 修法 (comment vs code 对齐):虽 git 操作已完成,
    // marker 清失败仍 return error 让 caller 显式知道 DB 写挂(silently ok return 会让 stale
    // marker 跟到下次 archive_plan 撞 4 态状态 4 误 reject)。
    // plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.8: error 路径加 markerCleared
    // 字段(false 表示 marker DB clear 失败 — 与 happy/partial-success 对称)
    return {
      error: `${input.action === 'remove' ? 'partial-success: worktree removed but ' : ''}clearCwdReleaseMarker failed: ${(e as Error).message}`,
      hint: `${input.action === 'remove' ? `worktree at ${worktreePath} (branch ${branchName ?? '<unknown>'}) was successfully removed, but ` : ''}the per-session cwd_release_marker DB clear failed (partial-success). Manual recovery: call enter_worktree to reset marker, then exit_worktree to clean up. Common causes: SQLite locked / DB connection lost / read-only filesystem.`,
      markerCleared: false,
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
