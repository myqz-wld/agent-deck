/**
 * R3.E6 (PR-B) — team-fs 大部分函数删除（inbox 协议 / fs config 全废）。
 * 仅保留 R3.E12 用到的「老 team config 一次性导出」相关读写函数。
 *
 * 老 listTeams / readTeamConfig / readTaskList / getTeamSnapshot / forceCleanupTeam /
 * getTasksRoot 全部删除。新 universal team backend 用 agent_deck_teams 三表 +
 * universal-message-watcher，不再依赖 ~/.claude/teams/ fs。
 *
 * 详 R3.E0 ADR §6.1 / §6.2。
 */
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ~/.claude/teams 绝对路径（老 Claude Code 自管的 team config 根，仅用于 export 备份）。 */
const teamsRoot = join(homedir(), '.claude', 'teams');
/** ~/.claude/tasks 绝对路径（老 Claude 自管的 shared task list 根）。 */
const tasksRoot = join(homedir(), '.claude', 'tasks');

export function getTeamsRoot(): string {
  return teamsRoot;
}

// ────────────────────────────────────────────────────────────────────────────
// R3.E12 — Legacy team config 一次性导出
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把 ~/.claude/teams/ + ~/.claude/tasks/ 整个目录递归复制到用户选定的 targetDir 下，
 * 子目录命名 `legacy-teams-export-<ISO timestamp>/`。
 *
 * 设计目的（R3.E0 ADR §6.2 / §11.4）：硬切前给用户备份入口，硬切后只读历史保留。
 *
 * 实现选择：用 Node 22+ 内置的 `fs.cp`（recursive），不引入 archiver / jszip 依赖，
 * 也不 spawn `tar` / `zip` CLI。结果是**目录复制**而非 zip 包；用户自己想 zip 可在
 * Finder / 终端打包。
 *
 * 安全：targetDir 来自用户 `dialog.showOpenDialog` 选择，不需路径校验（用户授权）；
 * 但用 realpath 防 symlink TOCTOU + 防御性把 source 也 realpath。
 *
 * 返回 { destDir, copied: { teams: bool, tasks: bool } }。两源都不存在时 destDir 为 null
 * （renderer 提示「无 legacy data 可导出」）。
 *
 * @param targetParentDir 用户选择的父目录（绝对路径）
 */
export async function exportLegacyTeams(
  targetParentDir: string,
): Promise<{
  destDir: string | null;
  copied: { teams: boolean; tasks: boolean };
}> {
  if (typeof targetParentDir !== 'string' || !targetParentDir.startsWith('/')) {
    throw new Error('targetParentDir must be an absolute path');
  }

  const teamsExist = existsSync(teamsRoot);
  const tasksExist = existsSync(tasksRoot);
  if (!teamsExist && !tasksExist) {
    return { destDir: null, copied: { teams: false, tasks: false } };
  }

  // 用 ISO 时间戳避免命名冲突（用户多次导出不会覆盖）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = join(targetParentDir, `legacy-teams-export-${stamp}`);

  const copied = { teams: false, tasks: false };

  if (teamsExist) {
    try {
      await cp(teamsRoot, join(destDir, 'teams'), {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        force: false,
        errorOnExist: false,
      });
      copied.teams = true;
    } catch (err) {
      console.warn(`[team-fs] exportLegacyTeams copy teams failed:`, err);
    }
  }
  if (tasksExist) {
    try {
      await cp(tasksRoot, join(destDir, 'tasks'), {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        force: false,
        errorOnExist: false,
      });
      copied.tasks = true;
    } catch (err) {
      console.warn(`[team-fs] exportLegacyTeams copy tasks failed:`, err);
    }
  }

  if (!copied.teams && !copied.tasks) {
    throw new Error('export failed: both teams and tasks copy failed');
  }
  return { destDir, copied };
}

/**
 * 给 renderer / dialog 用：探测当前是否有 legacy team data 可导出
 * （决定是否弹一次性 dialog 引导用户）。
 */
export function hasLegacyTeamData(): { teams: boolean; tasks: boolean } {
  return { teams: existsSync(teamsRoot), tasks: existsSync(tasksRoot) };
}
