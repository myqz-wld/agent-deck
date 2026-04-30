/**
 * IPC bootstrap entry。按原 src/main/ipc.ts:bootstrapIpc() 的顺序调用各 register 函数，
 * 避免任何 channel 注册时机被无意改变。
 *
 * 子 module：
 * - _helpers.ts          on() / IpcInputError / 8 个 parseXxx
 * - window-app.ts        AppGetVersion + Window* + Dialog* + AppPlayTestSound + AppShowTestNotification + DialogConfirm
 * - sessions.ts          Session* + SessionListHistory
 * - hooks.ts             HookInstall / Uninstall / Status
 * - settings.ts          SettingsGet / Set + 9 apply / warn helper + ClaudeMd*
 * - adapters.ts          Adapter* (createSession / sendMessage / RespondPermission / etc.)
 * - permissions.ts       PermissionScanCwd / PermissionOpenFile
 * - images.ts            ImageLoadBlob + 双白名单 + TOCTOU 防护
 * - teams.ts             SummarizerLastErrors + Team* + TeamPermission*
 */
import { registerWindowAppIpc } from './window-app';
import { registerSessionsIpc } from './sessions';
import { registerHooksIpc } from './hooks';
import { registerSettingsIpc } from './settings';
import { registerAdaptersIpc } from './adapters';
import { registerPermissionsIpc } from './permissions';
import { registerImagesIpc } from './images';
import { registerTeamsIpc } from './teams';

export function bootstrapIpc(): void {
  registerWindowAppIpc();
  registerSessionsIpc();
  registerHooksIpc();
  registerSettingsIpc();
  registerAdaptersIpc();
  registerPermissionsIpc();
  registerImagesIpc();
  registerTeamsIpc();
}
