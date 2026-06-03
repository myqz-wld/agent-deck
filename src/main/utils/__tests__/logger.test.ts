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
import { setFileLevel, cleanupOldLogs, shouldDropWebFrameMainDisposedNoise, installWebFrameMainDisposedFileFilter } from '../logger';

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

  /**
   * plan log-noise-and-disposed-20260603 §D2-revised-v2 (reviewer-codex R2 HIGH-1 修法):
   * filter 应装到 `log.hooks` (Logger 实例级, electron-log v5 src/core/Logger.js:177
   * `this.hooks.reduce((msg, hook) => msg ? hook(msg, transFn, transName) : msg, ...)`),
   * NOT `log.transports.file.hooks` (Transport 实际无 hooks 字段 — 详 §D2-revised-v2 注释)。
   * 锚点 'Error sending from webFrameMain' + 'Render frame was disposed' 单 arg 同时
   * 命中,限定 transportName='file' 才丢;pass-through 返原 message(R2 实证:reduce 短路
   * 语义依赖返 truthy,返 undefined 会让 transport 跳过)。
   */
  describe('shouldDropWebFrameMainDisposedNoise (HIGH-1 修法 anchor filter)', () => {
    it('双关键词同时命中 data[0] → 返 true 丢', () => {
      expect(
        shouldDropWebFrameMainDisposedNoise({
          data: ['Error sending from webFrameMain:  Error: Render frame was disposed before WebFrameMain could be accessed'],
        }),
      ).toBe(true);
    });

    it('双关键词分布在 data 多项中 → 返 false 透传 (单 arg 同时命中, 不 OR 拼接防误吞)', () => {
      expect(
        shouldDropWebFrameMainDisposedNoise({
          data: [
            'Error sending from webFrameMain: ',
            'Error: Render frame was disposed before WebFrameMain could be accessed',
          ],
        }),
      ).toBe(false);
    });

    it('仅 "Render frame was disposed" 命中 (无 webFrameMain 前缀) → 透传', () => {
      expect(
        shouldDropWebFrameMainDisposedNoise({
          data: ['Render frame was disposed in some other context'],
        }),
      ).toBe(false);
    });

    it('仅 "Error sending from webFrameMain" 命中 (无 disposed 后缀) → 透传', () => {
      expect(
        shouldDropWebFrameMainDisposedNoise({
          data: ['Error sending from webFrameMain: something else went wrong'],
        }),
      ).toBe(false);
    });

    it('完全不相关业务 log → 透传', () => {
      expect(shouldDropWebFrameMainDisposedNoise({ data: ['hello world'] })).toBe(false);
    });

    it('data 含非 string 元素 + string 项双关键词命中 → 返 true', () => {
      expect(
        shouldDropWebFrameMainDisposedNoise({
          data: [
            new Error('Render frame was disposed'),
            42,
            'Error sending from webFrameMain:  Error: Render frame was disposed',
          ],
        }),
      ).toBe(true);
    });

    it('空 data 数组 → 透传', () => {
      expect(shouldDropWebFrameMainDisposedNoise({ data: [] })).toBe(false);
    });
  });

  /**
   * plan log-noise-and-disposed-20260603 §D2-revised-v2 (reviewer-codex R2 HIGH-1):
   * hook 装到 Logger 实例级 `log.hooks`,不是 transport 级;signature 收 (msg, transFn, transName);
   * 限定 transportName='file' 才丢,console transport 透传(保 dev 终端可见);
   * pass-through 返原 message(R2 实证 reduce 短路语义依赖 truthy)。
   * vitest-setup.ts 全局 mock electron-log/main,`log.hooks` 是 mock 数组,直接断言即可。
   */
  describe('installWebFrameMainDisposedFileFilter (HIGH-1 hook install + dedup + semantics)', () => {
    beforeEach(() => {
      // logger.ts module-load 已 install 一次; test 再调 install 是 dedup path。
      // 测新 push 行为: 先清 log.hooks(我们的 hook 装在这里), install 再验。
      (log as unknown as { hooks: unknown[] }).hooks = [];
    });

    it('install → log.hooks 长度 +1, 末位是 hook 函数', () => {
      const before = (log as unknown as { hooks: unknown[] }).hooks.length;
      installWebFrameMainDisposedFileFilter();
      const after = (log as unknown as { hooks: unknown[] }).hooks.length;
      expect(after).toBe(before + 1);
      const hooks = (log as unknown as { hooks: ((msg: unknown, trans: unknown, name?: string) => unknown)[] }).hooks;
      expect(typeof hooks[hooks.length - 1]).toBe('function');
    });

    it('重复 install 同样 hook → log.hooks 长度不变 (dedup by ref equality)', () => {
      installWebFrameMainDisposedFileFilter();
      installWebFrameMainDisposedFileFilter();
      installWebFrameMainDisposedFileFilter();
      const hooks = (log as unknown as { hooks: unknown[] }).hooks;
      expect(hooks.length).toBe(1);
    });

    it('hook 装在 log.hooks (Logger 实例级), NOT log.transports.file.hooks (Transport 无 hooks 字段)', () => {
      // 关键 HIGH-1 修法: 早期修法装错对象,现应装到 Logger.hooks。
      // 强转 access transports.file.hooks,验证该位置无 hook(实现层无该字段也无所谓,
      // 我们关心「装对地方」: log.hooks 增 1, transports.file.hooks 不应有这个 hook)。
      const fileTransport = (log as unknown as { transports: { file: { hooks?: unknown[] } } }).transports.file;
      const fileHooksBefore = (fileTransport.hooks ?? []).length;
      installWebFrameMainDisposedFileFilter();
      const logHooks = (log as unknown as { hooks: unknown[] }).hooks;
      const fileHooksAfter = (fileTransport.hooks ?? []).length;
      expect(logHooks.length).toBe(1);
      // fileTransport.hooks 长度不应因此 install 变化
      expect(fileHooksAfter).toBe(fileHooksBefore);
    });

    it('hook 行为: transportName=file + 双关键词命中 → 返 false (丢)', () => {
      installWebFrameMainDisposedFileFilter();
      const hook = (log as unknown as { hooks: ((m: { data: unknown[] }, t: unknown, n?: string) => unknown)[] }).hooks[0];
      const result = hook(
        { data: ['Error sending from webFrameMain:  Error: Render frame was disposed'] },
        () => undefined,
        'file',
      );
      expect(result).toBe(false);
    });

    it('hook 行为: transportName=file + 仅单关键词 → 返原 message (透传, 不丢)', () => {
      installWebFrameMainDisposedFileFilter();
      const hook = (log as unknown as { hooks: ((m: { data: unknown[] }, t: unknown, n?: string) => unknown)[] }).hooks[0];
      const msg = { data: ['Render frame was disposed'] };
      const result = hook(msg, () => undefined, 'file');
      expect(result).toBe(msg);
    });

    it('hook 行为: transportName=console + 双关键词命中 → 返原 message (dev 终端保留可见, 不丢)', () => {
      installWebFrameMainDisposedFileFilter();
      const hook = (log as unknown as { hooks: ((m: { data: unknown[] }, t: unknown, n?: string) => unknown)[] }).hooks[0];
      const msg = { data: ['Error sending from webFrameMain:  Error: Render frame was disposed'] };
      const result = hook(msg, () => undefined, 'console');
      expect(result).toBe(msg);
    });

    it('hook 行为: transportName=undefined (e.g. 内部调用) + 双关键词命中 → 仍返原 message (保守透传)', () => {
      // 修法选择: transportName 缺省时**不丢**(避免 0 名调用误吞),
      // 比「transportName 必传才过滤」更安全。
      installWebFrameMainDisposedFileFilter();
      const hook = (log as unknown as { hooks: ((m: { data: unknown[] }, t: unknown, n?: string) => unknown)[] }).hooks[0];
      const msg = { data: ['Error sending from webFrameMain:  Error: Render frame was disposed'] };
      const result = hook(msg, () => undefined, undefined);
      expect(result).toBe(msg);
    });
  });
});
