/**
 * Runtime logging IPC handlers — Settings LogsSection 后端 (Plan runtime-logging-electron-log-20260529 §D9 §Step 3.2.5).
 *
 * 3 个 typed handler:
 * - LogsOpenDirectory       打开整个 logs 目录 (shell.openPath)
 * - LogsShowCurrentInFinder 选中今天的 main-YYYY-MM-DD.log (fallback: 文件不存在 → openPath)
 * - LogsTruncateToday       清空当天 log 文件 (fallback: 文件不存在 → 返 false 让 UI 弹 toast)
 */
import { app, shell } from 'electron';
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
}
