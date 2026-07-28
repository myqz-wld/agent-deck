import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const scopedLogger = {
    warn: vi.fn(),
    error: vi.fn(),
  };
  const logFile = {
    path: '',
    reset: vi.fn(),
    clear: vi.fn(),
  };
  return {
    handlers,
    listeners,
    scopedLogger,
    logFile,
    getFile: vi.fn(() => logFile),
    getLogsPath: vi.fn(() => ''),
    openPath: vi.fn().mockResolvedValue(''),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getLogsPath,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      mocks.listeners.set(channel, listener);
    }),
  },
  shell: {
    openPath: mocks.openPath,
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    scope: vi.fn(() => mocks.scopedLogger),
    transports: {
      file: {
        getFile: mocks.getFile,
      },
    },
  },
}));

import { IpcInvoke } from '@shared/ipc-channels';
import {
  readTodayLog,
  registerLogsIpc,
  sanitizePreloadFatalPayload,
  truncateTodayLog,
} from '../logs';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-logs-test-'));
  mocks.handlers.clear();
  mocks.listeners.clear();
  mocks.scopedLogger.warn.mockReset();
  mocks.scopedLogger.error.mockReset();
  mocks.logFile.path = '';
  mocks.logFile.reset.mockReset();
  mocks.logFile.clear.mockReset();
  mocks.getFile.mockClear();
  mocks.getLogsPath.mockReturnValue(tempDir);
  mocks.openPath.mockReset().mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('logs IPC file operations', () => {
  it('returns a successful empty state for a nonexistent log without creating it', () => {
    const filePath = path.join(tempDir, 'missing.log');

    expect(readTodayLog(filePath)).toEqual({
      ok: true,
      existed: false,
      path: filePath,
    });
    expect(truncateTodayLog(filePath)).toEqual({ ok: true, existed: false });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(mocks.getFile).not.toHaveBeenCalled();
  });

  it('rejects a symlink without reading or truncating its target', () => {
    const victimPath = path.join(tempDir, 'victim.txt');
    const logPath = path.join(tempDir, 'today.log');
    fs.writeFileSync(victimPath, 'do-not-touch');
    fs.symlinkSync(victimPath, logPath);

    const readResult = readTodayLog(logPath);
    const truncateResult = truncateTodayLog(logPath);

    expect(readResult).toMatchObject({ ok: false, existed: true });
    expect(truncateResult).toMatchObject({ ok: false, existed: true });
    expect(fs.readFileSync(victimPath, 'utf8')).toBe('do-not-touch');
    expect(mocks.getFile).not.toHaveBeenCalled();
  });

  it('detects a path swap while truncating and never truncates the replacement target', () => {
    const victimPath = path.join(tempDir, 'victim.txt');
    const logPath = path.join(tempDir, 'today.log');
    const openedPath = path.join(tempDir, 'opened.log');
    fs.writeFileSync(victimPath, 'do-not-touch');
    fs.writeFileSync(logPath, 'original-log');
    mocks.logFile.path = logPath;

    const realFtruncate = fs.ftruncateSync.bind(fs);
    vi.spyOn(fs, 'ftruncateSync').mockImplementationOnce((fd, length) => {
      fs.renameSync(logPath, openedPath);
      fs.symlinkSync(victimPath, logPath);
      realFtruncate(fd, length);
    });

    const result = truncateTodayLog(logPath);

    expect(result).toMatchObject({ ok: false, existed: true });
    expect(fs.readFileSync(victimPath, 'utf8')).toBe('do-not-touch');
    expect(fs.readFileSync(openedPath, 'utf8')).toBe('');
    expect(mocks.logFile.reset).toHaveBeenCalledTimes(1);
    expect(mocks.logFile.clear).not.toHaveBeenCalled();
  });

  it('truncates only through the verified descriptor and resets electron-log size state', () => {
    const logPath = path.join(tempDir, 'today.log');
    fs.writeFileSync(logPath, 'some log data');
    mocks.logFile.path = logPath;
    const truncatePath = vi.spyOn(fs, 'truncateSync');

    const result = truncateTodayLog(logPath);

    expect(result).toEqual({ ok: true, existed: true });
    expect(fs.readFileSync(logPath, 'utf8')).toBe('');
    expect(truncatePath).not.toHaveBeenCalled();
    expect(mocks.logFile.clear).not.toHaveBeenCalled();
    expect(mocks.logFile.reset).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful read result when close fails and logs a bounded diagnostic', () => {
    const logPath = path.join(tempDir, 'today.log');
    fs.writeFileSync(logPath, 'read me');
    const realClose = fs.closeSync.bind(fs);
    vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
      realClose(fd);
      throw new Error(`close failed ${'x'.repeat(20_000)}`);
    });

    const result = readTodayLog(logPath);

    expect(result).toMatchObject({ ok: true, existed: true, content: 'read me' });
    expect(mocks.scopedLogger.warn).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.stringify(mocks.scopedLogger.warn.mock.calls[0]?.[1]);
    expect(diagnostic.length).toBeLessThan(3_000);
    expect(diagnostic).not.toContain('x'.repeat(3_000));
  });

  it('keeps a successful truncate result when close fails', () => {
    const logPath = path.join(tempDir, 'today.log');
    fs.writeFileSync(logPath, 'clear me');
    mocks.logFile.path = logPath;
    const realClose = fs.closeSync.bind(fs);
    vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
      realClose(fd);
      throw new Error('close failed');
    });

    expect(truncateTodayLog(logPath)).toEqual({ ok: true, existed: true });
    expect(fs.readFileSync(logPath, 'utf8')).toBe('');
    expect(mocks.scopedLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the primary result even if close diagnostics also fail', () => {
    const logPath = path.join(tempDir, 'today.log');
    fs.writeFileSync(logPath, 'read me');
    const realClose = fs.closeSync.bind(fs);
    vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
      realClose(fd);
      throw new Error('close failed');
    });
    mocks.scopedLogger.warn.mockImplementationOnce(() => {
      throw new Error('diagnostic failed');
    });

    expect(readTodayLog(logPath)).toMatchObject({
      ok: true,
      existed: true,
      content: 'read me',
    });
  });

  it('caps reads at the newest 2 MiB and removes a split UTF-8 leading boundary', () => {
    const cap = 2 * 1024 * 1024;
    const logPath = path.join(tempDir, 'today.log');
    const content = Buffer.concat([
      Buffer.from('汉'),
      Buffer.alloc(cap - 2, 'a'),
    ]);
    fs.writeFileSync(logPath, content);

    const result = readTodayLog(logPath);

    expect(result).toMatchObject({
      ok: true,
      existed: true,
      truncated: true,
      size: cap + 1,
    });
    expect(result.content).not.toContain('\uFFFD');
    expect(Buffer.byteLength(result.content ?? '', 'utf8')).toBe(cap - 2);
    expect(result.content?.startsWith('a')).toBe(true);
  });
});

describe('preload fatal diagnostics', () => {
  it('validates shape, bounds fields, and never logs the raw payload', () => {
    const hugeMessage = `message:${'m'.repeat(20_000)}`;
    const hugeStack = `stack:${'s'.repeat(20_000)}`;

    const sanitized = sanitizePreloadFatalPayload({
      message: hugeMessage,
      stack: hugeStack,
    });
    expect(sanitized.message.length).toBeLessThan(600);
    expect(sanitized.stack.length).toBeLessThan(2_200);

    registerLogsIpc();
    const listener = mocks.listeners.get(IpcInvoke.PreloadFatalError);
    expect(listener).toBeTypeOf('function');
    listener?.({}, { message: hugeMessage, stack: hugeStack });

    const logged = String(mocks.scopedLogger.error.mock.calls[0]?.[0]);
    expect(logged.length).toBeLessThan(3_000);
    expect(logged).not.toContain('m'.repeat(1_000));
    expect(logged).not.toContain('s'.repeat(3_000));
    expect(JSON.stringify(mocks.scopedLogger.error.mock.calls[0])).not.toContain(hugeMessage);
  });

  it('uses a fixed diagnostic for malformed payloads', () => {
    expect(sanitizePreloadFatalPayload(['raw-secret'])).toEqual({
      message: '<invalid payload>',
      stack: '<no stack>',
    });
    expect(sanitizePreloadFatalPayload({ message: 42 })).toEqual({
      message: '<invalid payload>',
      stack: '<no stack>',
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(sanitizePreloadFatalPayload(revoked.proxy)).toEqual({
      message: '<invalid payload>',
      stack: '<no stack>',
    });
  });
});
