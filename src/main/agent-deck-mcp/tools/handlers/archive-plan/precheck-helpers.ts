/**
 * archive_plan 预检 helpers（CHANGELOG_169 F1 Step 1.2 从 archive-plan-impl.ts 抽出）。
 *
 * 含 mainRepo dirty precheck + baseBranch 命名 / namespace 校验两段独立逻辑，原文件 archive-plan-impl.ts
 * 通过 `export { ... } from './archive-plan/precheck-helpers'` re-export 保 test seam（4 个
 * test 文件直接 import 这些函数做单元测试，import path 零改动）。
 *
 * ===========================================================================
 * Internal-only test seams (plan deep-review-batch-a1-b-followup-r3-20260519
 * §Phase 1.2a + 1.2b / D6 export production lambda)
 *
 * 抽 archivePlanImpl 内 mainRepo precheck (step 3.5) + baseBranch 校验 (step 7)
 * 两段逻辑为 module-level export,让 __tests__/ 调真实代码而非 inline 复制合约
 * (H4 教训 — REVIEW_47 §A1-HIGH-1)。
 *
 * 严禁外部 production 文件 import 这两个 lambda — 业务路径仍走 archivePlanImpl
 * 内部 step 3.5 / step 7 调用 (`hasError` 不变, handler 不知 lambda 存在)。
 * ===========================================================================
 */

import * as path from 'node:path';

/**
 * @internal Only for `__tests__/`. Do NOT import from other production files.
 *
 * mainRepo 三具体路径 dirty precheck（plan deep-review-batch-a1-b-followup-r3-20260519
 * §Phase 1.2a / D6 + R3 plan-review codex MED-1 + MED-3 修订）。
 *
 * **R3 plan-review codex HIGH-3 修订**：用 `git status --porcelain=v1 -z` NUL 分隔（防 filename 含
 * rename / 含空格 path / quoted path，避免 newline-split parser 漏 rename 类型）。
 *
 * **R3 plan-review codex MED-1 修订**：三具体路径必须转 repo-relative 才能与 git status
 * 输出比对（archive-plan-impl.ts:648 实证 archivedPath 是绝对路径 `path.join(mainRepo, ...)`；
 * git status --porcelain 输出 repo-relative 如 ` M README.md\0`；绝对 vs relative 比对
 * **永不命中**）。
 *
 * **R3 plan-review codex MED-3 修订**：rename/copy 类型（status[0]='R'|'C'）格式
 * `"RY newname\0oldname\0"` 两段 NUL 分隔，parser 必须读两段；同时检查 old/new path 是否
 * 命中 critical（任一命中即 reject）。
 */
export interface AssertMainRepoCleanInput {
  mainRepoAbsPath: string;
  archivedPath: string;
  indexPath: string;
  planFilePath: string;
}

/** porcelain entry: status XY + 1-2 paths（普通 1 段 / rename-copy 2 段 new->old）。 */
export interface MainRepoStatusEntry {
  /** 显示用 path 字符串（rename/copy 类型 = "newname -> oldname"）。 */
  path: string;
  /** git status --porcelain XY 二字符状态码（如 "M ", " M", "MM", "??", "R ", "C "）。 */
  status: string;
}

export interface AssertMainRepoCleanResult {
  ok: boolean;
  /** 命中三具体路径的 dirty entries（reject 归档）。 */
  conflicts: MainRepoStatusEntry[];
  /** 不命中三具体路径的 dirty entries（warn pass，commit message 加注脚）。 */
  warnings: MainRepoStatusEntry[];
}

export async function assertMainRepoCleanForArchive(
  deps: { runGit: (args: string[], cwd: string, opts?: { raw?: boolean }) => Promise<string> },
  input: AssertMainRepoCleanInput,
): Promise<AssertMainRepoCleanResult> {
  // critical paths 转 repo-relative 与 git status 输出对齐（R3 codex MED-1）
  const criticalSet = new Set([
    path.relative(input.mainRepoAbsPath, input.archivedPath),
    path.relative(input.mainRepoAbsPath, input.indexPath),
    path.relative(input.mainRepoAbsPath, input.planFilePath),
  ]);

  let stdout: string;
  try {
    // **R3 fix-2 (H2 codex Batch B HIGH-1)**：传 `{ raw: true }` 跳 trim 防破坏 -z NUL 输出
    // （HISTORICAL bug repro literal,不迁 ref/plans/：`' M plans/INDEX.md\0'.trim()` → `'M plans/INDEX.md\0'` 首列 space 被吃 → status 错位
    // → criticalSet 永不命中 → Y 列 unstaged critical path 全漏判）。
    //
    // **R3 fix-2 (H4 codex Batch C+D 未验证升级)**：加 `--untracked-files=all` flag 让 untracked
    // 文件展开到完整路径而非目录级（HISTORICAL bug repro literal,不迁 ref/plans/：default mode 输出 `?? plans/\0` → criticalSet.has('plans/
    // INDEX.md') 不命中 → untracked critical 文件全漏判；`--untracked-files=all` 输出
    // `?? plans/INDEX.md\0?? plans/myplan.md\0` 才能命中）。HISTORICAL: bug repro literal block
    stdout = await deps.runGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      input.mainRepoAbsPath,
      { raw: true },
    );
  } catch (e) {
    // git 失败 → fail-safe ok=false 让 caller decide，不静默 ok（防 mainRepo git 异常时
    // ghost-archive）。但也不抛 — caller 收到结构化结果在 step 3.5 调用方包成 error 返回。
    return {
      ok: false,
      conflicts: [{ path: '<git-status-failed>', status: (e as Error).message }],
      warnings: [],
    };
  }

  if (!stdout) {
    // mainRepo clean
    return { ok: true, conflicts: [], warnings: [] };
  }

  const conflicts: MainRepoStatusEntry[] = [];
  const warnings: MainRepoStatusEntry[] = [];

  // parse NUL-separated entries:
  // - 普通:  "XY filename\0"           (X = staged status, Y = unstaged status)
  // - rename/copy: "RY newname\0oldname\0"  (X='R' or 'C', 两段 NUL)
  let i = 0;
  while (i < stdout.length) {
    const firstNul = stdout.indexOf('\0', i);
    if (firstNul < 0) break;
    const entry = stdout.substring(i, firstNul); // "XY filename"
    if (entry.length < 3) {
      // malformed, skip
      i = firstNul + 1;
      continue;
    }
    const status = entry.substring(0, 2);
    const filename = entry.substring(3);
    i = firstNul + 1;

    const paths = [filename];
    if (status[0] === 'R' || status[0] === 'C') {
      // rename/copy 第二段：oldname
      const secondNul = stdout.indexOf('\0', i);
      if (secondNul >= 0) {
        const oldname = stdout.substring(i, secondNul);
        paths.push(oldname);
        i = secondNul + 1;
      }
    }

    // 任一 path 命中 critical 即 conflict（rename 把 plan/INDEX/archived 重命名风险高）
    const hitCritical = paths.some((p) => criticalSet.has(p));
    const displayPath = paths.length > 1 ? paths.join(' -> ') : paths[0];
    if (hitCritical) {
      conflicts.push({ path: displayPath, status });
    } else {
      warnings.push({ path: displayPath, status });
    }
  }

  return { ok: conflicts.length === 0, conflicts, warnings };
}

/**
 * @internal Only for `__tests__/`. Do NOT import from other production files.
 *
 * baseBranch refs/heads namespace 校验（plan deep-review-batch-a1-b-fixes-20260519
 * §Phase 1 Step 1.2 / B-HIGH-3 修法）。
 *
 * 旧 impl `rev-parse --verify <branch>` 接受 SHA / tag / detached HEAD（git man 默认
 * namespace 含 refs/heads/ refs/tags/ refs/remotes/ raw SHA 等），caller 误传 tag 名当
 * baseBranch（典型: plan frontmatter `baseBranch: v1.2.0`）→ checkout tag 后 detached
 * HEAD → ff-merge 推 HEAD → commit 落 detached → branch -D worktreeBranch 删工作分支 ref
 * → 归档 commit 仅 reflog 可达，gc 30 天后丢失（B-HIGH-3 reviewer-claude 反驳轮 git
 * 端到端实测复现）。修法：显式 verify `refs/heads/<branch>` namespace，强制 named branch
 * （plan-review MED-1 claude 修订：rev-parse --verify --quiet refs/heads/ 比 symbolic-ref
 * 语义更直观）。
 */
export interface AssertBaseBranchInput {
  mainRepoAbsPath: string;
  baseBranch: string;
}

export interface AssertBaseBranchResult {
  ok: boolean;
  /** 失败时给 caller 的人类可读错误（含具体 baseBranch 名 + git stderr 摘录）。 */
  error?: string;
  /** 失败时给 caller 的修复建议（指向 plan frontmatter 修订 / git branch --list）。 */
  hint?: string;
}

export async function assertBaseBranchIsNamedBranch(
  deps: { runGit: (args: string[], cwd: string, opts?: { raw?: boolean }) => Promise<string> },
  input: AssertBaseBranchInput,
): Promise<AssertBaseBranchResult> {
  // **R3 fix-2 (H3 codex Batch C+D HIGH-1)**：先 `git check-ref-format --branch <name>` reject
  // rev suffix（`main~1` / `main^{commit}` 等）。仅 `git rev-parse --verify --quiet refs/heads/X`
  // 不够 — 实测 `git rev-parse --verify --quiet refs/heads/main~1` 返回 commit hash exit 0
  // （rev-parse 接受 `refs/heads/main~1` 作为 valid rev expression：从 main 倒退一个 commit）。
  // 后续 ff-merge `git checkout main~1` 会进入 detached HEAD → 归档 commit 落 detached HEAD
  // → B-HIGH-3 同款数据丢失风险。`git check-ref-format --branch main~1` exit 128 实测铁证拦下。
  try {
    await deps.runGit(['check-ref-format', '--branch', input.baseBranch], input.mainRepoAbsPath);
  } catch (e) {
    return {
      ok: false,
      error: `baseBranch "${input.baseBranch}" is not a valid branch name (contains rev syntax like '~' / '^{commit}' or other illegal chars).`,
      hint:
        `archive_plan ff-merge requires a plain branch name (no rev suffix); names containing '~' / '^' / '@{' are rev expressions ` +
        `that would resolve to a commit + ` +
        `git checkout <name> → detached HEAD → archive commit lost after branch -D + gc. ` +
        `Edit plan frontmatter baseBranch to a plain branch name (e.g. "main" / "feature-x"). ` +
        `Verify with \`git -C ${input.mainRepoAbsPath} check-ref-format --branch <name>\`. ${(e as Error).message}`,
    };
  }
  try {
    await deps.runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${input.baseBranch}`],
      input.mainRepoAbsPath,
    );
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `baseBranch "${input.baseBranch}" is not a named branch (refs/heads/<name>); SHA / tag / detached HEAD refs are not allowed.`,
      hint:
        `archive_plan ff-merge requires a named branch to commit onto. If "${input.baseBranch}" is a tag or SHA, ` +
        `plan cannot be archived (commits would land on detached HEAD and be lost after branch -D + gc). ` +
        `Edit plan frontmatter baseBranch to a named branch (e.g. "main" / "feature-x"), or pass baseBranch arg explicitly. ` +
        `Verify with \`git -C ${input.mainRepoAbsPath} branch --list\`. ${(e as Error).message}`,
    };
  }
}
