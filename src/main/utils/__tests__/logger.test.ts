/**
 * src/main/utils/__tests__/logger.test.ts
 *
 * Plan runtime-logging-electron-log-20260529 §Step 3.5.1.
 *
 * **范围**: main logger.ts 6 个 assert 验 §D3 (按天 + cleanup) / §D4 (file/console level) /
 * §D5 (NODE_ENV='test' 不接管 console) / §D7 (errorHandler.startCatching init 即跑).
 *
 * **mock 策略实证**:
 * Plan §Step 3.5.1 spec 原写 vi.unmock('electron-log/main') + vi.doMock('electron', stub) 序列
 * 让测试拿真 electron-log/main + 注入 stub electron. **vitest 2.1.9 实测此模式无效** — 顶部
 * vi.mock factory 引用 outer scope 报 "There was an error when mocking a module" + 即使用
 * vi.hoisted 共享变量 vi.mock factory 内 vi.importActual('electron-log/main') 仍走真模块
 * (再撞 Electron failed to install).
 *
 * **修法折中** (plan §D15 testing-only 妥协): 不 unmock electron-log/main, 接受 vitest-setup.ts
 * 全局 mock 的 mock-mediated 行为 — 测 logger.ts 是否按 spec **调用了 mock** 上的方法 (initialize
 * / errorHandler.startCatching / transports.file/console.level 设置 / etc), 而不是验证 real
 * electron-log API 的真实行为.
 *
 * **代价 / 后续**: 实际 electron-log API drift (真包 major upgrade 后字段重命名 / 行为变化) 本
 * 测试不能 catch — 留 plan §Step 3.7 e2e .app dist 验证作为兜底 (生产场景实测 log 真落盘 = 真包
 * 行为正常). 后续 vitest 升级若支持 setupFiles mock override, 再回填此测试.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import log from 'electron-log/main';
import { setFileLevel, cleanupOldLogs } from '../logger';

const mockedLog = log as unknown as {
  initialize: ReturnType<typeof vi.fn>;
  errorHandler: { startCatching: ReturnType<typeof vi.fn> };
  transports: {
    file: { level: string | false; resolvePathFn: unknown };
    console: { level: string | false };
  };
  functions: { log: unknown; warn: unknown; error: unknown };
};

describe('main logger.ts (Plan §Step 3.5.1, mock-mediated 折中)', () => {
  it('NODE_ENV="test" 时不接管 console (D5 + §不变量 2)', () => {
    expect(process.env.NODE_ENV).toBe('test');
    // 守门跑 false: console.log / warn / error 不应该是 logger wrapper
    expect(console.log).not.toBe(mockedLog.functions.log);
    expect(console.warn).not.toBe(mockedLog.functions.warn);
    expect(console.error).not.toBe(mockedLog.functions.error);
  });

  it('logger import 时调 log.initialize() (D8 IPC bridge)', () => {
    expect(mockedLog.initialize).toHaveBeenCalled();
  });

  it('logger import 时调 errorHandler.startCatching() (D7 fatal hook)', () => {
    expect(mockedLog.errorHandler.startCatching).toHaveBeenCalled();
  });

  it('resolvePathFn 设置成函数, 返回 main-YYYY-MM-DD.log 格式 (D3 按天拆)', () => {
    const fn = mockedLog.transports.file.resolvePathFn as unknown;
    expect(fn).toBeTypeOf('function');
    const p = (fn as () => string)();
    expect(p).toMatch(/main-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it('默认 file.level === "info" AND console.level === "silly" (D4)', () => {
    expect(mockedLog.transports.file.level).toBe('info');
    expect(mockedLog.transports.console.level).toBe('silly');
  });

  it('setFileLevel("warn") 只改 file.level, console.level 不变 (D4 修订)', () => {
    setFileLevel('warn');
    expect(mockedLog.transports.file.level).toBe('warn');
    expect(mockedLog.transports.console.level).toBe('silly');
    // 复位避免影响其他 test
    setFileLevel('info');
  });

  describe('cleanupOldLogs (D3) — 不依赖 electron-log mock, 纯 fs 行为测试', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = path.join(
        os.tmpdir(),
        `agent-deck-logger-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('删 mtime > 14 天的 main-*.log, 保留 < 14 天, 不动其他文件名', () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const fixtures = [
        { name: 'main-2025-04-29.log', mtime: now - 30 * day, expectDeleted: true },
        { name: 'main-2025-05-19.log', mtime: now - 10 * day, expectDeleted: false },
        { name: 'main-2025-05-29.log', mtime: now, expectDeleted: false },
        { name: 'unrelated.log', mtime: now - 30 * day, expectDeleted: false }, // 不带 main- 前缀
      ];
      for (const f of fixtures) {
        const p = path.join(tmpDir, f.name);
        fs.writeFileSync(p, '');
        fs.utimesSync(p, new Date(f.mtime), new Date(f.mtime));
      }

      const deleted = cleanupOldLogs(tmpDir, 14);
      expect(deleted).toBe(1);

      for (const f of fixtures) {
        const p = path.join(tmpDir, f.name);
        const exists = fs.existsSync(p);
        expect(
          exists,
          `${f.name}: expectDeleted=${f.expectDeleted}, actual exists=${exists}`,
        ).toBe(!f.expectDeleted);
      }
    });

    it('LOG_DIR 不存在时返 0 不挂', () => {
      const nonExist = path.join(tmpDir, 'nonexistent-subdir');
      expect(cleanupOldLogs(nonExist, 14)).toBe(0);
    });
  });
});
