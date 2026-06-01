/**
 * Runtime logging IPC handlers — Settings LogsSection 后端 (Plan runtime-logging-electron-log-20260529 §D9 §Step 3.2.5).
 *
 * 3 个 typed handler (Settings LogsSection):
 * - LogsOpenDirectory  打开整个 logs 目录 (shell.openPath)
 * - LogsReadToday      读当天 main-YYYY-MM-DD.log 文本供应用内 Monaco 只读查看
 *                      (fallback: 文件不存在 → existed:false 让 UI 显空态; 文件 > 2MB → 读尾部 2MB + truncated:true)
 * - LogsTruncateToday  清空当天 log 文件 (fallback: 文件不存在 → 返 false 让 UI 弹 toast)
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

/** 应用内 Monaco 查看的 tail cap: 当天 log 正常 ≤1MB (electron-log maxSize rotate), 防御性 2MB 上限. */
const LOG_READ_TAIL_CAP = 2 * 1024 * 1024;

/** 与 logger.ts §D3 todayStr() 同款本地时区 YYYY-MM-DD. */
function todayLogFile(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(app.getPath('logs'), `main-${y}-${m}-${d}.log`);
}

/** lstat 拒 symlink (不 follow), 与 LogsTruncateToday 同源防护: filePath 恒在 logs dir 内,
 *  唯一攻击面是当天 log 文件被换成 symlink → 读/清会 follow 到任意同权限文件. */
function refuseSymlink(filePath: string): { ok: false; error: string } | null {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      return { ok: false, error: 'refusing to read a symlink at the log path' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return null;
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

  // 读当天日志供应用内 Monaco 只读查看 (D9 fallback: 文件不存在 → existed:false; > 2MB → tail cap)
  on(
    IpcInvoke.LogsReadToday,
    async (): Promise<{
      ok: boolean;
      existed: boolean;
      content?: string;
      truncated?: boolean;
      size?: number;
      path?: string;
      error?: string;
    }> => {
      const filePath = todayLogFile();
      if (!fs.existsSync(filePath)) {
        return { ok: true, existed: false, path: filePath };
      }
      const sym = refuseSymlink(filePath);
      if (sym) return { ...sym, existed: true, path: filePath };
      try {
        const size = fs.statSync(filePath).size;
        if (size <= LOG_READ_TAIL_CAP) {
          const content = fs.readFileSync(filePath, 'utf-8');
          return { ok: true, existed: true, content, truncated: false, size, path: filePath };
        }
        // > 2MB: 只读尾部 LOG_READ_TAIL_CAP 字节 (日志尾部=最新, 用户最关心), 标 truncated
        const fd = fs.openSync(filePath, 'r');
        try {
          const buf = Buffer.alloc(LOG_READ_TAIL_CAP);
          const read = fs.readSync(fd, buf, 0, LOG_READ_TAIL_CAP, size - LOG_READ_TAIL_CAP);
          return {
            ok: true,
            existed: true,
            content: buf.subarray(0, read).toString('utf-8'),
            truncated: true,
            size,
            path: filePath,
          };
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        logger.warn('LogsReadToday read failed', err);
        return {
          ok: false,
          existed: true,
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

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
