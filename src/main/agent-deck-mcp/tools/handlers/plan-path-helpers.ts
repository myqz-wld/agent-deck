/**
 * plan file path 解析 helper(plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.9
 * 修法 B-MED-3 双方独立强冗余):archive-plan-impl 与 hand-off-session-impl 共享同一 fallback
 * 链 SSOT。
 *
 * **修前差异**:
 * - archive-plan-impl.ts L394-415 已实现 3 档 fallback(projectLocal > projectArchived >
 *   userGlobal),包含本项目实际惯例的中间档 `<main-repo>/ref/plans/<id>.md`
 * - hand-off-session-impl.ts L201-218 仅 2 档(projectLocal > userGlobal),漏中间档
 *   → caller 不传 plan_file_path 且 plan 文件在 `<main-repo>/ref/plans/`(本项目实际惯例 30+
 *   stub plan 都直接创在 ref/plans/)时全失败,hand-off 无法 cold-start 已归档 plan
 *
 * **修法**:抽 helper 让两个 caller 共享同一 fallback 链 + INDEX message + Tried path 列表。
 *
 * **签名约束**:
 * - mainRepo `string | null`:hand_off generic 模式 / archive_plan 反查失败时可能为 null,
 *   null 时跳过 project-scoped 路径(projectLocal / projectArchived)只查 userGlobal
 * - deps 接口仅 exists + homedir(两个 caller deps 都已有此 2 字段,helper 不需 fs.stat 等)
 */
import path from 'node:path';

export interface ResolvePlanPathDeps {
  exists: (p: string) => Promise<boolean>;
  homedir: () => string;
}

export type ResolvePlanPathResult =
  | { path: string }
  | { error: string; hint: string };

/**
 * 按 fallback 链解析 plan 文件路径:
 * 1. `<main-repo>/.claude/plans/<id>.md` — project-specific in_progress local 工作目录
 *    (user CLAUDE.md §Step 2 优先)
 * 2. `<main-repo>/ref/plans/<id>.md` — project-internal git 归档目录(本项目实际惯例,
 *    archive_plan 完成后 mv 目标位置;30+ stub plan 直接创在此)
 * 3. `~/.claude/plans/<id>.md` — cross-project plan / CLI `/plan` slash command 默认位置
 *
 * mainRepo === null → 跳过路径 1+2,仅查路径 3。
 *
 * 返回 `{ path }` 或 `{ error, hint }`(`hint` 含 Tried 完整路径列表方便 caller diagnose)。
 */
export async function resolvePlanFilePath(
  mainRepo: string | null,
  planId: string,
  deps: ResolvePlanPathDeps,
): Promise<ResolvePlanPathResult> {
  const projectLocal = mainRepo
    ? path.join(mainRepo, '.claude', 'plans', `${planId}.md`)
    : null;
  const projectArchived = mainRepo
    ? path.join(mainRepo, 'ref', 'plans', `${planId}.md`)
    : null;
  const userGlobal = path.join(deps.homedir(), '.claude', 'plans', `${planId}.md`);

  if (projectLocal && (await deps.exists(projectLocal))) return { path: projectLocal };
  if (projectArchived && (await deps.exists(projectArchived))) return { path: projectArchived };
  if (await deps.exists(userGlobal)) return { path: userGlobal };

  const triedList = [projectLocal, projectArchived, userGlobal]
    .filter((p): p is string => p !== null)
    .join('\n       ');
  const mainRepoNote =
    mainRepo === null ? ' (caller cwd is not a git repo, skipped <main-repo>/ lookups)' : '';
  return {
    error: `plan file not found at any default location`,
    hint: `Tried: ${triedList}${mainRepoNote}\nPass plan_file_path explicitly to override, or check that plan_id "${planId}" matches the file stem.`,
  };
}
