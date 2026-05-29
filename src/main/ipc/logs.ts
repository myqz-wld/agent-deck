/**
 * Runtime logging IPC handlers — Settings LogsSection 后端 (Plan runtime-logging-electron-log-20260529 §D9 §Step 3.2.5).
 *
 * 3 个 typed handler (Settings LogsSection):
 * - LogsOpenDirectory       打开整个 logs 目录 (shell.openPath)
 * - LogsShowCurrentInFinder 选中今天的 main-YYYY-MM-DD.log (fallback: 文件不存在 → openPath)
 * - LogsTruncateToday       清空当天 log 文件 (fallback: 文件不存在 → 返 false 让 UI 弹 toast)
 *
 * 1 个 fire-and-forget event listener (Plan §Step 3.2.6 follow-up, CHANGELOG_179 方案 2):
 * - PreloadFatalError       preload 端 contextBridge.exposeInMainWorld 失败时上报落 logger
 */
import { app, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import log from '@main/utils/logger';
import { IpcInvoke } from '@shared/ipc-channels';
import { on } from './_helpers';

const logger = log.scope('ipc-logs');

/** 与 logger.ts §D3 todayStr() 同款本地时区 YYYY-MM-DD. */
function todayLogFile(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(app.getPath('logs'), `main-${y}-${m}-${d}.log`);
}

export function registerLogsIpc(): void {
  // 打开整个 logs 目录
  on(IpcInvoke.LogsOpenDirectory, async (): Promise<{ ok: boolean; error?: string }> => {
    const dir = app.getPath('logs');
    const err = await shell.openPath(dir);
    if (err) {
      logger.warn('LogsOpenDirectory openPath failed', err);
      return { ok: false, error: err };
    }
    return { ok: true };
  });

  // 在 Finder 中显示当前日志 (D9 fallback: 文件不存在 → openPath LOG_DIR)
  on(IpcInvoke.LogsShowCurrentInFinder, async (): Promise<{ ok: boolean; fallback?: boolean; error?: string }> => {
    const filePath = todayLogFile();
    if (!fs.existsSync(filePath)) {
      // fallback: 当天 log 还没写过 → 退化为打开整个 logs 目录, 避免 macOS showItemInFolder 不存在
      // 路径行为不可靠 (实测可能弹「找不到该项目」对话框)
      const dir = app.getPath('logs');
      const err = await shell.openPath(dir);
      if (err) {
        logger.warn('LogsShowCurrentInFinder fallback openPath failed', err);
        return { ok: false, fallback: true, error: err };
      }
      return { ok: true, fallback: true };
    }
    shell.showItemInFolder(filePath); // void return, 失败 macOS 静默 (无 promise)
    return { ok: true };
  });

  // 清空当天日志 (D9 fallback: 文件不存在 → 返 false 让 UI 弹 toast)
  on(IpcInvoke.LogsTruncateToday, async (): Promise<{ ok: boolean; existed: boolean; error?: string }> => {
    const filePath = todayLogFile();
    if (!fs.existsSync(filePath)) {
      return { ok: true, existed: false };
    }
    try {
      fs.truncateSync(filePath, 0);
      logger.info(`LogsTruncateToday truncated ${filePath}`);
      return { ok: true, existed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`LogsTruncateToday truncate failed: ${msg}`, err);
      return { ok: false, existed: true, error: msg };
    }
  });

  // CHANGELOG_179 §Step 3.2.6 方案 2: preload 端 contextBridge.exposeInMainWorld('api', api)
  // 失败时上报落 logger.scope('preload-fatal'). 与 webContents.on('preload-error', ...) 互补
  // (本 channel 拦加载成功后内部 throw, preload-error 拦 script 本身加载失败).
  // fire-and-forget 不需 ack, 用 ipcMain.on 而非 invoke/handle.
  const preloadLogger = log.scope('preload-fatal');
  ipcMain.on(IpcInvoke.PreloadFatalError, (_event, payload: { message?: string; stack?: string } | undefined) => {
    const message = payload?.message ?? '<no message>';
    const stack = payload?.stack ?? '<no stack>';
    preloadLogger.error(`contextBridge.exposeInMainWorld failed: ${message}\n${stack}`);
  });
}
