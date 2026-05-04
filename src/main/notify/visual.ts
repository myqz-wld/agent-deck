import { app, Notification } from 'electron';
import { settingsStore } from '@main/store/settings-store';
import { getFloatingWindow } from '@main/window';
import { IS_DARWIN } from '@main/platform';
import { playSoundOnce } from './sound';

interface NotifyOpts {
  title: string;
  body: string;
  /** 'waiting' | 'finished' | 'info' */
  level: 'waiting' | 'finished' | 'info';
}

export function notifyUser(opts: NotifyOpts): void {
  const settings = settingsStore.getAll();
  const win = getFloatingWindow().window;
  const focused = win?.isFocused() ?? false;

  // 静音：聚焦时不响声
  const shouldPlay =
    settings.enableSound && (!settings.silentWhenFocused || !focused);
  if (shouldPlay) {
    if (opts.level === 'waiting') playSoundOnce('waiting');
    else if (opts.level === 'finished') playSoundOnce('done');
  }

  // 不再做窗口 flash —— 闪屏太抢眼，靠声音 + 系统通知 + Dock 弹跳就够。

  if (settings.enableSystemNotification) {
    if (Notification.isSupported()) {
      new Notification({
        title: opts.title,
        body: opts.body,
        silent: !shouldPlay,
      }).show();
    }
  }

  // Dock bounce 是 macOS 专属（NSDockTile API）；Win/Linux 没有 dock 概念，
  // 任务栏闪烁靠 Electron `BrowserWindow.flashFrame()` 走另一条 API（行为差异较大），
  // 这里 by design 只 macOS 触发；Win 上 system notification + 声音已经够提示。
  if (IS_DARWIN && opts.level === 'waiting') {
    app.dock?.bounce('informational');
  }
}
