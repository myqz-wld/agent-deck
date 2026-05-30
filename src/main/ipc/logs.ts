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
    // REVIEW_68 batch-2 [LOW reviewer-codex]: 拒 symlink（lstat 不 follow）。filePath 由 todayLogFile()
    // 内部构造恒在 logs dir 内，唯一攻击面是当天 log 文件本身被换成 symlink → truncate/writeFile 会
    // follow 到任意同权限可写文件。lstat 命中 symlink 直接拒（与 ipc/images.ts realpath 加固同源思路）。
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        return { ok: false, existed: true, error: 'refusing to truncate a symlink at the log path' };
      }
    } catch (err) {
      return { ok: false, existed: true, error: err instanceof Error ? err.message : String(err) };
    }
    // REVIEW_68 batch-2 [MED reviewer-codex]: 用 electron-log File.clear() 而非 fs.truncateSync。
    // file transport 缓存每个 path 的 File 对象（initialSize + bytesWritten 判 maxSize rotation，默认
    // maxSize=1MB）。fs.truncateSync 绕过缓存 → 清空 >1MB 日志后 cached size 仍旧 → 下条写触发过早
    // rotation / 覆盖 .old.log。File.clear() = writeFileSync('') + reset 缓存，rotation 计数同步归零。
    // [LOW reviewer-claude]: 不再 truncate 后 logger.info 写回（否则「已清空」立即又有一条记录）；
    // 失败仅经 result.error 返 renderer 弹 toast，不写回当天 file（console 已被 logger 接管会写回）。
    const cleared = log.transports.file.getFile().clear();
    if (!cleared) {
      return { ok: false, existed: true, error: 'electron-log File.clear() failed (see emitted transport error)' };
    }
    return { ok: true, existed: true };
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
