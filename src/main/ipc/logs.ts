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

/** tail buffer 开头若落在多字节 UTF-8 序列中间 (日志含大量 CJK, 每字符 3 字节), 直接
 *  toString('utf-8') 会在开头产生 U+FFFD 替换字符。从首字节起跳过 continuation byte
 *  (0b10xxxxxx) 定位到下一个完整 code point 起始 (ASCII 0xxxxxxx / 多字节首字节 11xxxxxx)。
 *  最多跳 3 字节 (UTF-8 单字符 ≤ 4 字节, continuation ≤ 3 个)。tail 截断专用, 全量读不调。 */
function trimLeadingPartialUtf8(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && start < 3 && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return start === 0 ? buf : buf.subarray(start);
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
  // **REVIEW (simple-review log+asset) MED 修法 (reviewer-codex path-based TOCTOU)**: 旧实现
  // lstat / statSync / readFileSync|openSync 全按 path 分多次 syscall — lstat 判非 symlink 后、
  // 真正 read 前, 文件可被换成 symlink → 后续 follow 到任意同权限文件; 小文件分支还按旧 size 进
  // ≤CAP 分支但 readFileSync 读当前内容 → 击穿 2MB cap。改成「开一次 fd, 基于同一 fd 决策 + 读取」:
  // openSync(O_NOFOLLOW 拒 symlink, 无 lstat→open 窗口) → fstatSync(fd) 拿 size (同 fd 无 stat→read
  // 窗口) → 一律按 min(size, CAP) 从 fd 读 (去掉 readFileSync path 分支)。
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
      let fd: number;
      try {
        // O_NOFOLLOW: 路径末段是 symlink 时 openSync 直接抛 ELOOP (不 follow), 取代旧 lstat
        // 预检 + 消除 lstat→open TOCTOU 窗口。文件不存在抛 ENOENT → existed:false。
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return { ok: true, existed: false, path: filePath };
        }
        if (code === 'ELOOP') {
          return { ok: false, existed: true, path: filePath, error: 'refusing to read a symlink at the log path' };
        }
        logger.warn('LogsReadToday open failed', err);
        return { ok: false, existed: true, path: filePath, error: err instanceof Error ? err.message : String(err) };
      }
      try {
        // fstatSync(fd) 而非 statSync(path): size 与后续 read 锁定同一 fd, 无 stat→read 窗口
        const size = fs.fstatSync(fd).size;
        const truncated = size > LOG_READ_TAIL_CAP;
        // ≤2MB 全读; >2MB 只读尾部 LOG_READ_TAIL_CAP 字节 (日志尾部=最新, 用户最关心)
        const readLen = truncated ? LOG_READ_TAIL_CAP : size;
        const position = truncated ? size - LOG_READ_TAIL_CAP : 0;
        const buf = Buffer.alloc(readLen);
        const read = fs.readSync(fd, buf, 0, readLen, position);
        // tail 截断时 buffer 开头可能落在多字节 UTF-8 序列中间 → trim 掉不完整起始字节防 U+FFFD
        const slice = buf.subarray(0, read);
        const content = (truncated ? trimLeadingPartialUtf8(slice) : slice).toString('utf-8');
        return { ok: true, existed: true, content, truncated, size, path: filePath };
      } catch (err) {
        logger.warn('LogsReadToday read failed', err);
        return {
          ok: false,
          existed: true,
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        fs.closeSync(fd);
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
