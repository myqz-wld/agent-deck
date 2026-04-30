/**
 * App / Window / Dialog 通用 IPC handler。
 */
import { app, dialog, nativeImage, Notification } from 'electron';
import { join } from 'node:path';
import { IpcInvoke } from '@shared/ipc-channels';
import { getFloatingWindow } from '@main/window';
import { playSoundOnce } from '@main/notify/sound';
import { on } from './_helpers';

export function registerWindowAppIpc(): void {
  on(IpcInvoke.AppGetVersion, () => app.getVersion());

  // Window
  on(IpcInvoke.WindowSetAlwaysOnTop, (_e, value) => {
    getFloatingWindow().setAlwaysOnTop(Boolean(value));
    return true;
  });
  on(IpcInvoke.WindowSetIgnoreMouse, (_e, value) => {
    getFloatingWindow().setIgnoreMouse(Boolean(value));
    return true;
  });
  on(IpcInvoke.WindowMinimize, () => {
    getFloatingWindow().window?.minimize();
    return true;
  });
  on(IpcInvoke.WindowToggleCompact, () => getFloatingWindow().toggleCompact());

  // Dialog
  on(IpcInvoke.DialogChooseDirectory, async (_e, defaultPath) => {
    const win = getFloatingWindow().window;
    const r = await (win
      ? dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
        })
      : dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
        }));
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  on(IpcInvoke.DialogChooseSoundFile, async (_e, defaultPath) => {
    const win = getFloatingWindow().window;
    const opts = {
      properties: ['openFile'] as ('openFile')[],
      filters: [
        { name: '音频文件', extensions: ['mp3', 'wav', 'aiff', 'aif', 'm4a', 'ogg', 'flac'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
    };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  on(IpcInvoke.DialogChooseExecutable, async (_e, defaultPath) => {
    // 选 codex 二进制路径用：macOS / Linux 的可执行文件通常无后缀，extensions: ['*']
    // 让 native dialog 不按后缀过滤；用户也可以自由选 .sh / .bin 等
    const win = getFloatingWindow().window;
    const opts = {
      properties: ['openFile'] as ('openFile')[],
      filters: [{ name: '所有文件', extensions: ['*'] }],
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
    };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  on(IpcInvoke.AppPlayTestSound, (_e, kind) => {
    const k = kind === 'waiting' || kind === 'done' ? kind : 'waiting';
    playSoundOnce(k);
    return true;
  });

  on(IpcInvoke.AppShowTestNotification, () => {
    if (!Notification.isSupported()) {
      return { ok: false, reason: 'Notification 不被当前平台/Electron 支持' };
    }
    try {
      new Notification({
        title: 'Agent Deck 测试通知',
        body: '如果你看到了这条横幅，说明系统通知正常工作。',
        silent: true,
      }).show();
      // 把 app.getName() 一并返回：dev 模式是 'Electron'，prod 是 'Agent Deck'。
      // renderer 里拼提示「请到 系统设置 → 通知 → ${appName}」时用这个值，
      // 不能写死 'Electron' —— 装好的 .app 用户去找 Electron 会找不到。
      return { ok: true, appName: app.getName() };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });

  on(IpcInvoke.DialogConfirm, async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string;
      message?: string;
      detail?: string;
      okLabel?: string;
      cancelLabel?: string;
      destructive?: boolean;
    };
    const win = getFloatingWindow().window;
    const iconPath = join(app.getAppPath(), 'resources', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    const buttons = [o.okLabel ?? '确定', o.cancelLabel ?? '取消'];
    const showOpts = {
      type: 'question' as const,
      title: o.title ?? '确认操作',
      message: o.message ?? '',
      detail: o.detail,
      buttons,
      defaultId: o.destructive ? 1 : 0,
      cancelId: 1,
      icon: icon.isEmpty() ? undefined : icon,
      noLink: true,
    };
    const r = win
      ? await dialog.showMessageBox(win, showOpts)
      : await dialog.showMessageBox(showOpts);
    return r.response === 0; // 0 = ok, 1 = cancel
  });
}
