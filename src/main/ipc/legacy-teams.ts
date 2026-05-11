/**
 * R3.E12 — Legacy team data 一次性导出 IPC handler。
 *
 * 解耦原因：放在独立文件而非 teams.ts，PR-B (E6) 删 teams.ts 大部分函数时本文件继续
 * 存在（保留 export 入口给老用户翻历史用）。
 *
 * 详 R3.E0 ADR §6.2 / §11.4 / §12 verification 7。
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { exportLegacyTeams, hasLegacyTeamData } from '@main/teams/team-fs';
import { on, IpcInputError } from './_helpers';

export function registerLegacyTeamsIpc(): void {
  // 探测：renderer 启动时调，决定一次性 dialog 弹不弹
  on(IpcInvoke.LegacyTeamsHasData, async () => hasLegacyTeamData());

  // 导出：用户在 Settings panel 点 export 按钮 + 选好父目录后调
  on(
    IpcInvoke.LegacyTeamsExport,
    async (_e, targetParentDir): Promise<{
      destDir: string | null;
      copied: { teams: boolean; tasks: boolean };
    }> => {
      if (typeof targetParentDir !== 'string' || !targetParentDir.startsWith('/')) {
        throw new IpcInputError(
          'targetParentDir',
          'must be an absolute path (got: ' + JSON.stringify(targetParentDir) + ')',
        );
      }
      return exportLegacyTeams(targetParentDir);
    },
  );
}
