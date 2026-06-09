/**
 * Resolve a plan file path for archive_plan. The fallback chain checks the
 * project draft path, project archive path, then user-global plan path.
 *
 * mainRepo can be null when caller cwd is not inside a git repo; in that case
 * only the user-global path is checked.
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
    hint: `Tried: ${triedList}${mainRepoNote}\nPass planFilePath explicitly to override, or check that planId "${planId}" matches the file stem.`,
  };
}
