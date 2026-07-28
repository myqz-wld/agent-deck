/**
 * Runtime log IPC handlers.
 *
 * File reads and truncation are bound to a verified descriptor so a path replacement cannot redirect
 * the operation. Reads return at most the newest 2 MiB, and truncation resets electron-log's cached
 * byte count only after the descriptor operation succeeds.
 */
import { app, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import log from '@main/utils/logger';
import {
  safeDiagnostic,
  safeDisplayText,
  toSafeErrorDetails,
} from '@main/utils/safe-diagnostic';
import { IpcInvoke } from '@shared/ipc-channels';
import { on } from './_helpers';

const logger = log.scope('ipc-logs');
const LOG_READ_TAIL_CAP = 2 * 1024 * 1024;
const PRELOAD_FATAL_MESSAGE_CAP = 512;
const PRELOAD_FATAL_STACK_CAP = 2_048;

export interface LogReadResult {
  ok: boolean;
  existed: boolean;
  content?: string;
  truncated?: boolean;
  size?: number;
  path?: string;
  error?: string;
}

export interface LogTruncateResult {
  ok: boolean;
  existed: boolean;
  error?: string;
}

interface ResettableLogFile {
  path: string;
  reset: () => void;
}

interface VerifiedFile {
  fd: number;
  stats: fs.Stats;
}

type VerifiedOpenResult =
  | { ok: true; file: VerifiedFile }
  | { ok: false; existed: boolean; error?: string };

function todayLogFile(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(app.getPath('logs'), `main-${y}-${m}-${d}.log`);
}

function errorMessage(error: unknown): string {
  return toSafeErrorDetails(error).message;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeFdSafely(fd: number, operation: 'read' | 'truncate' | 'verify'): void {
  try {
    fs.closeSync(fd);
  } catch (error) {
    try {
      logger.warn(
        `Logs ${operation} descriptor close failed`,
        safeDiagnostic({ operation, error }),
      );
    } catch {
      // A secondary diagnostic failure must not replace the completed file operation.
    }
  }
}

function pathStillNamesFile(filePath: string, openedStats: fs.Stats): boolean {
  try {
    const current = fs.lstatSync(filePath);
    return current.isFile() && !current.isSymbolicLink() && sameFile(current, openedStats);
  } catch {
    return false;
  }
}

/**
 * The lstat is an early rejection only. Security does not depend on it: the opened descriptor is
 * compared with that exact inode before use, and every subsequent read/truncate targets the fd.
 */
function openVerifiedRegularFile(filePath: string, accessFlag: number): VerifiedOpenResult {
  let expected: fs.Stats;
  try {
    expected = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, existed: false };
    }
    return { ok: false, existed: true, error: errorMessage(error) };
  }
  if (expected.isSymbolicLink()) {
    return { ok: false, existed: true, error: 'refusing to access a symlink at the log path' };
  }
  if (!expected.isFile()) {
    return { ok: false, existed: true, error: 'refusing to access a non-file log path' };
  }

  let fd: number;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const nonBlocking = fs.constants.O_NONBLOCK ?? 0;
    fd = fs.openSync(filePath, accessFlag | noFollow | nonBlocking);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, existed: true, error: 'log path changed before it could be opened' };
    }
    if (code === 'ELOOP' || code === 'EMLINK') {
      return { ok: false, existed: true, error: 'refusing to access a symlink at the log path' };
    }
    return { ok: false, existed: true, error: errorMessage(error) };
  }

  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFile(expected, opened)) {
      closeFdSafely(fd, 'verify');
      return { ok: false, existed: true, error: 'log path changed while it was being opened' };
    }
    return { ok: true, file: { fd, stats: opened } };
  } catch (error) {
    closeFdSafely(fd, 'verify');
    return { ok: false, existed: true, error: errorMessage(error) };
  }
}

function trimLeadingPartialUtf8(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.length && start < 3 && (buffer[start]! & 0xc0) === 0x80) {
    start++;
  }
  return start === 0 ? buffer : buffer.subarray(start);
}

export function readTodayLog(filePath: string): LogReadResult {
  const opened = openVerifiedRegularFile(filePath, fs.constants.O_RDONLY);
  if (!opened.ok) {
    if (!opened.existed) return { ok: true, existed: false, path: filePath };
    return { ok: false, existed: true, path: filePath, error: opened.error };
  }

  const { fd, stats } = opened.file;
  let result: LogReadResult;
  try {
    const size = stats.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      result = {
        ok: false,
        existed: true,
        path: filePath,
        error: 'log size is outside the supported range',
      };
    } else {
      const truncated = size > LOG_READ_TAIL_CAP;
      const readLength = Math.min(size, LOG_READ_TAIL_CAP);
      const position = truncated ? size - readLength : 0;
      const buffer = Buffer.allocUnsafe(readLength);
      let totalRead = 0;
      while (totalRead < readLength) {
        const count = fs.readSync(
          fd,
          buffer,
          totalRead,
          readLength - totalRead,
          position + totalRead,
        );
        if (count === 0) break;
        totalRead += count;
      }
      const bytes = buffer.subarray(0, totalRead);
      const content = (truncated ? trimLeadingPartialUtf8(bytes) : bytes).toString('utf8');
      result = pathStillNamesFile(filePath, stats)
        ? { ok: true, existed: true, content, truncated, size, path: filePath }
        : {
            ok: false,
            existed: true,
            path: filePath,
            error: 'log path changed while it was being read',
          };
    }
  } catch (error) {
    logger.warn('LogsReadToday read failed', safeDiagnostic(error));
    result = {
      ok: false,
      existed: true,
      path: filePath,
      error: errorMessage(error),
    };
  } finally {
    closeFdSafely(fd, 'read');
  }
  return result;
}

function currentElectronLogFile(filePath: string): ResettableLogFile | null {
  try {
    const candidate = log.transports.file.getFile() as unknown as Partial<ResettableLogFile>;
    if (
      typeof candidate.path !== 'string'
      || path.resolve(candidate.path) !== path.resolve(filePath)
      || typeof candidate.reset !== 'function'
    ) {
      return null;
    }
    return candidate as ResettableLogFile;
  } catch (error) {
    logger.warn('LogsTruncateToday electron-log file lookup failed', safeDiagnostic(error));
    return null;
  }
}

export function truncateTodayLog(filePath: string): LogTruncateResult {
  const opened = openVerifiedRegularFile(filePath, fs.constants.O_WRONLY);
  if (!opened.ok) {
    if (!opened.existed) return { ok: true, existed: false };
    return { ok: false, existed: true, error: opened.error };
  }

  const { fd, stats } = opened.file;
  let result: LogTruncateResult;
  try {
    if (!pathStillNamesFile(filePath, stats)) {
      result = { ok: false, existed: true, error: 'log path changed before truncation' };
    } else {
      const electronLogFile = currentElectronLogFile(filePath);
      if (!electronLogFile) {
        result = {
          ok: false,
          existed: true,
          error: 'electron-log file state is unavailable',
        };
      } else {
        fs.ftruncateSync(fd, 0);
        electronLogFile.reset();
        result = pathStillNamesFile(filePath, stats)
          ? { ok: true, existed: true }
          : {
              ok: false,
              existed: true,
              error: 'log path changed while it was being truncated',
            };
      }
    }
  } catch (error) {
    logger.warn('LogsTruncateToday truncate failed', safeDiagnostic(error));
    result = { ok: false, existed: true, error: errorMessage(error) };
  } finally {
    closeFdSafely(fd, 'truncate');
  }
  return result;
}

function ownDataValue(
  payload: Record<PropertyKey, unknown>,
  key: 'message' | 'stack',
): { valid: boolean; value?: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(payload, key);
    if (!descriptor) return { valid: true };
    if (!('value' in descriptor)) return { valid: false };
    return { valid: true, value: descriptor.value };
  } catch {
    return { valid: false };
  }
}

function boundedFatalText(value: string, cap: number): string {
  const truncated = value.length > cap;
  const bounded = value.slice(0, cap);
  const safe = safeDisplayText(bounded);
  return truncated ? `${safe}…[truncated]` : safe;
}

function isPlainPayloadRecord(payload: unknown): payload is Record<PropertyKey, unknown> {
  if (typeof payload !== 'object' || payload === null) return false;
  try {
    if (Array.isArray(payload)) return false;
    const prototype = Object.getPrototypeOf(payload);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function sanitizePreloadFatalPayload(
  payload: unknown,
): { message: string; stack: string } {
  if (!isPlainPayloadRecord(payload)) {
    return { message: '<invalid payload>', stack: '<no stack>' };
  }
  const message = ownDataValue(payload, 'message');
  const stack = ownDataValue(payload, 'stack');
  if (
    !message.valid
    || !stack.valid
    || (message.value !== undefined && typeof message.value !== 'string')
    || (stack.value !== undefined && typeof stack.value !== 'string')
  ) {
    return { message: '<invalid payload>', stack: '<no stack>' };
  }
  return {
    message: typeof message.value === 'string'
      ? boundedFatalText(message.value, PRELOAD_FATAL_MESSAGE_CAP)
      : '<no message>',
    stack: typeof stack.value === 'string'
      ? boundedFatalText(stack.value, PRELOAD_FATAL_STACK_CAP)
      : '<no stack>',
  };
}

export function registerLogsIpc(): void {
  on(IpcInvoke.LogsOpenDirectory, async (): Promise<{ ok: boolean; error?: string }> => {
    const error = await shell.openPath(app.getPath('logs'));
    if (error) {
      logger.warn('LogsOpenDirectory openPath failed', safeDiagnostic(error));
      return { ok: false, error: safeDisplayText(error) };
    }
    return { ok: true };
  });

  on(IpcInvoke.LogsReadToday, async (): Promise<LogReadResult> => (
    readTodayLog(todayLogFile())
  ));

  on(IpcInvoke.LogsTruncateToday, async (): Promise<LogTruncateResult> => (
    truncateTodayLog(todayLogFile())
  ));

  const preloadLogger = log.scope('preload-fatal');
  ipcMain.on(IpcInvoke.PreloadFatalError, (_event, payload: unknown) => {
    const diagnostic = sanitizePreloadFatalPayload(payload);
    preloadLogger.error(
      `contextBridge.exposeInMainWorld failed: ${diagnostic.message}\n${diagnostic.stack}`,
    );
  });
}
