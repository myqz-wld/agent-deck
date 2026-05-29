/**
 * archive-plan-impl 共享 types / helpers / consts (plan deep-project-review-comprehensive-20260528
 * Step 4.2 拆分产物，从原 archive-plan-impl.ts 1281 LOC facade 抽出共享层，给 4 子模块 + facade
 * re-export 共享，避免子模块 ↔ facade 类型 / 工厂函数循环依赖)。
 *
 * **设计** (与 Step 4.1 hand-off-session/_deps.ts 同款 pattern):
 * - types: ArchivePlanInput / Result / Error / Deps + PostFfMergePhase + 4 子模块 XxxResult interfaces
 * - helpers: isError 类型守卫 + postFfMergeErr 统一 error 构造器 + formatLocalDate + stripFrontmatter
 * - consts: POST_FF_MERGE_* hint 字符串 + DEFAULT_DEPS + indexSyncFlight Map (singleton)
 *
 * **Facade re-export**：`archive-plan-impl.ts` re-export 全部 public types + isError as
 * `_isArchivePlanError` (test seam) + DEFAULT_DEPS 内部使用，让外部 import path 零改动。
 * 4 个 impl-<phase> 子模块都直接 import from 本文件，不走 facade 转一圈避免 runtime cycle。
 */

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
} from '../_shared/default-impl-deps';

// ===========================================================================
// public types — facade re-exports for external callers (test + production handler)
// ===========================================================================

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

// ===========================================================================
// internal types — sub-module return shapes (4 子模块串联用,facade 不需 re-export)
// ===========================================================================

/** runPrecheck (Step 1-6) 输出: facade 解构后传给 ff-merge / archive-fs / cleanup ctx。 */
export interface PrecheckResult {
  mainRepo: string;
  worktreeBranch: string;
  planFilePath: string;
  /** Step 6 frontmatter — Step 7 base_branch fallback 用,post-ff-merge 后用 freshFm 而非 fm */
  fm: Record<string, string>;
  archivedDir: string;
  archivedPath: string;
  indexPath: string;
  /** Step 3.5 mainRepo dirty precheck 结果(warnings 数组传给 cleanup commit msg 注脚) */
  mainRepoClean: { warnings: Array<{ status: string; path: string }> };
  /** Step 4 cwd 4 态分流标记(true 时 cleanup 阶段 archive 完整成功后 release marker) */
  releaseMarkerOnSuccess: boolean;
}

/** runFfMerge (Step 7-8c) 输出: facade 解构后传给 archive-fs ctx。 */
export interface FfMergeResult {
  finalCommit: string;
  freshContent: string;
  freshFm: Record<string, string>;
}

/** runArchiveFs (Step 9-12.5) 输出: facade 解构后传给 cleanup ctx + ok return。 */
export interface ArchiveFsResult {
  plansIndexAction: ArchivePlanResult['plansIndexAction'];
  spikeReportsArchived: ArchivePlanResult['spikeReportsArchived'];
}

/** runCleanup (Step 13-14) 输出: facade 解构后构造 ok return。 */
export interface CleanupResult {
  archiveCommit: string;
  branchDeleted: string;
  worktreeRemoved: string;
}

// ===========================================================================
// helpers — type guard + post-ff-merge error factory + frontmatter / date utils
// ===========================================================================

/**
 * Type guard for `T | ArchivePlanError` discriminated union — facade orchestrator 4 子模块
 * 串联时复用,test 通过 `_isArchivePlanError` alias 用。Generic 版本让 narrow path 同时
 * 适配 PrecheckResult / FfMergeResult / ArchiveFsResult / CleanupResult / ArchivePlanResult
 * 5 种 success 形状 + 共用 ArchivePlanError 失败形状。
 */
export function isError<T>(x: T | ArchivePlanError): x is ArchivePlanError {
  return (x as ArchivePlanError).error !== undefined;
}

/** YYYY-MM-DD 本地时区（与 plan 文件 frontmatter `created_at` 风格一致）。 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 取 frontmatter block 后的所有正文（含 frontmatter 后第一个换行之后的所有字节）。 */
export function stripFrontmatter(text: string): string {
  const m = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  if (!m) return text;
  return text.slice(m[0].length);
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

// ===========================================================================
// consts — DEFAULT_DEPS + indexSyncFlight singleton Map
// ===========================================================================

export const DEFAULT_DEPS: Required<ArchivePlanDeps> = {
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
export const indexSyncFlight: Map<string, Promise<void>> = new Map();
