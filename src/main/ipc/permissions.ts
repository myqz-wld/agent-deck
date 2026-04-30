/**
 * Permission settings 扫描 / 打开候选 settings.json IPC handler。
 */
import { shell } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import { scanCwdSettings, getCandidatePaths } from '@main/permissions/scanner';
import { on } from './_helpers';

export function registerPermissionsIpc(): void {
  // Permissions: 扫描 cwd 对应的三层 settings.json，纯只读
  on(IpcInvoke.PermissionScanCwd, async (_e, cwd) => {
    return scanCwdSettings(String(cwd ?? ''));
  });

  // Permissions: 用系统默认应用打开某个 settings.json。为防越权（renderer 传任意 path 直接 openPath），
  // 严格校验 path 必须是该 cwd 的四个候选路径之一（user / user-local / project / local）。
  on(IpcInvoke.PermissionOpenFile, async (_e, cwd, path) => {
    const candidates = getCandidatePaths(String(cwd ?? ''));
    const allowed = new Set([
      candidates.user,
      candidates.userLocal,
      candidates.project,
      candidates.local,
    ]);
    const target = String(path ?? '');
    if (!allowed.has(target)) {
      return { ok: false, reason: 'path not in candidate list' };
    }
    // shell.openPath 文件不存在时返回非空错误字符串；我们把它当作业务失败回传给前端。
    const errorMsg = await shell.openPath(target);
    return errorMsg ? { ok: false, reason: errorMsg } : { ok: true };
  });
}
