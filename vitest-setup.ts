/**
 * Vitest 全局 setup — 给所有 *.test.ts 共享的 module mock
 *
 * Plan: runtime-logging-electron-log-20260529 §设计决策 D15 + §Step 3.0.2.5
 *
 * 解决问题:
 * 1. `electron` package 在 vitest node env 跑 `getElectronPath` 抛 `Electron failed to install correctly`
 *    (baseline 30/90 测试文件 / 69/802 测试都因此 fail)
 * 2. `electron-log/main` 入口顶层 `require('electron')` (electron-log v5.4.4 source 实证)
 *    Step 3.3 354 处 console.* migrate 后, 业务模块 `import { logger } from '@main/utils/logger'`
 *    会通过 import 链触发 `import 'electron-log/main'` → `require('electron')` → 同样 fail
 *
 * mock 范围 (D15 §mock 范围明确 / Round 2 fix R2-2 边界注解):
 * - mock: `electron` + `electron-log/main` (main 入口顶层 require electron)
 * - NOT mock: `electron-log/renderer` (renderer 入口顶层不 require electron, lazy IPC 调用安全)
 * - NOT mock: `electron-log/node` (spike runner 入口, 纯 Node 不依赖 electron)
 *
 * 兼容性 (Step 3.0.2.5 验证清单):
 * - test file 内 local `vi.mock(...)` 自动覆盖本 setup 的全局 mock (vitest hoist 优先级: local > setupFiles)
 * - bundled-assets-multi-root.test.ts:74 已有 local `vi.mock('electron', ...)` — 继续生效
 * - settings-store.test.ts 已有 local `vi.mock('electron-store', ...)` — 与本 setup 正交, 无冲突
 * - logger.test.ts (Step 3.5 才写) 需 `vi.unmock('electron-log/main')` + `vi.doMock('electron', factoryWithRealishApi)` 局部覆盖验真 API drift
 */

import { vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

// ─── electron mock ───────────────────────────────────────────────────────
// 业务模块 grep 出来的 app.* 调用清单 (Step 3.0.2.5 prep):
//   getPath / getAppPath / setName / getName / whenReady / requestSingleInstanceLock
//   quit / exit / on / once / off / focus / getVersion / setLoginItemSettings / isPackaged
// 其他 (BrowserWindow / dialog / shell / Notification / nativeImage / screen / globalShortcut / ipcMain)
// 见各组同款 vi.fn() 兜底.
vi.mock('electron', () => {
  const fakeBase = path.join(os.tmpdir(), 'agent-deck-test');
  const fakeAppPath = path.join(fakeBase, 'app');

  return {
    app: {
      isPackaged: false,
      getPath: vi.fn((name: string) => path.join(fakeBase, name)),
      getAppPath: vi.fn(() => fakeAppPath),
      getName: vi.fn(() => 'Agent Deck'),
      setName: vi.fn(),
      getVersion: vi.fn(() => '0.0.0-test'),
      getLocale: vi.fn(() => 'en-US'),
      whenReady: vi.fn(() => Promise.resolve()),
      requestSingleInstanceLock: vi.fn(() => true),
      releaseSingleInstanceLock: vi.fn(),
      hasSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
      exit: vi.fn(),
      focus: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      setLoginItemSettings: vi.fn(),
      setAboutPanelOptions: vi.fn(),
      setAppUserModelId: vi.fn(),
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        appendArgument: vi.fn(),
        hasSwitch: vi.fn(() => false),
        getSwitchValue: vi.fn(() => ''),
      },
      dock: {
        show: vi.fn(),
        hide: vi.fn(),
        setBadge: vi.fn(),
        setIcon: vi.fn(),
      },
    },
    BrowserWindow: Object.assign(
      vi.fn().mockImplementation(() => ({
        loadURL: vi.fn(() => Promise.resolve()),
        loadFile: vi.fn(() => Promise.resolve()),
        show: vi.fn(),
        hide: vi.fn(),
        close: vi.fn(),
        destroy: vi.fn(),
        focus: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isMinimized: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        webContents: {
          send: vi.fn(),
          on: vi.fn(),
          openDevTools: vi.fn(),
          isDestroyed: vi.fn(() => false),
        },
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        setBounds: vi.fn(),
        getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
        setVibrancy: vi.fn(),
        setVisibleOnAllWorkspaces: vi.fn(),
        setAlwaysOnTop: vi.fn(),
      })),
      {
        getAllWindows: vi.fn(() => []),
        fromWebContents: vi.fn(() => null),
        fromId: vi.fn(() => null),
      },
    ),
    ipcMain: {
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      handle: vi.fn(),
      handleOnce: vi.fn(),
      removeHandler: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    dialog: {
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
      showMessageBoxSync: vi.fn(() => 0),
      showErrorBox: vi.fn(),
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
      showOpenDialogSync: vi.fn(() => undefined),
      showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true, filePath: undefined })),
    },
    shell: {
      openPath: vi.fn(() => Promise.resolve('')),
      openExternal: vi.fn(() => Promise.resolve()),
      showItemInFolder: vi.fn(),
      trashItem: vi.fn(() => Promise.resolve()),
      beep: vi.fn(),
    },
    Notification: Object.assign(
      vi.fn().mockImplementation(() => ({
        show: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
      })),
      {
        isSupported: vi.fn(() => true),
      },
    ),
    nativeImage: {
      createEmpty: vi.fn(() => ({
        isEmpty: vi.fn(() => true),
        toDataURL: vi.fn(() => ''),
        toPNG: vi.fn(() => Buffer.alloc(0)),
        getSize: vi.fn(() => ({ width: 0, height: 0 })),
      })),
      createFromPath: vi.fn(() => ({
        isEmpty: vi.fn(() => false),
        toDataURL: vi.fn(() => ''),
        toPNG: vi.fn(() => Buffer.alloc(0)),
        getSize: vi.fn(() => ({ width: 16, height: 16 })),
      })),
      createFromBuffer: vi.fn(() => ({
        isEmpty: vi.fn(() => false),
        toDataURL: vi.fn(() => ''),
        toPNG: vi.fn(() => Buffer.alloc(0)),
        getSize: vi.fn(() => ({ width: 16, height: 16 })),
      })),
      createFromDataURL: vi.fn(() => ({
        isEmpty: vi.fn(() => false),
        toDataURL: vi.fn(() => ''),
        toPNG: vi.fn(() => Buffer.alloc(0)),
        getSize: vi.fn(() => ({ width: 16, height: 16 })),
      })),
    },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        id: 0,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
        rotation: 0,
        size: { width: 1920, height: 1080 },
        workAreaSize: { width: 1920, height: 1080 },
      })),
      getAllDisplays: vi.fn(() => []),
      getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
      getDisplayMatching: vi.fn(() => ({
        id: 0,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
      })),
      getDisplayNearestPoint: vi.fn(() => ({
        id: 0,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
    globalShortcut: {
      register: vi.fn(() => true),
      registerAll: vi.fn(),
      unregister: vi.fn(),
      unregisterAll: vi.fn(),
      isRegistered: vi.fn(() => false),
    },
    Menu: Object.assign(
      vi.fn().mockImplementation(() => ({
        append: vi.fn(),
        popup: vi.fn(),
        closePopup: vi.fn(),
      })),
      {
        buildFromTemplate: vi.fn(() => ({
          popup: vi.fn(),
          closePopup: vi.fn(),
        })),
        setApplicationMenu: vi.fn(),
        getApplicationMenu: vi.fn(() => null),
      },
    ),
    MenuItem: vi.fn(),
    Tray: vi.fn().mockImplementation(() => ({
      setImage: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    })),
  };
});

// ─── electron-log/main mock ──────────────────────────────────────────────
// logger.ts (df3f4b1) 用到的 API:
//   log.initialize / log.scope / log.errorHandler.startCatching
//   log.transports.file.{resolvePathFn, level} / log.transports.console.level
//   log.functions / log.info|warn|error|debug|silly|verbose (业务模块 D12 logger.<level>())
//
// D15 §logger.test.ts 局部 unmock 路径: Step 3.5 写 logger.test.ts 时 vi.unmock('electron-log/main')
// + vi.doMock('electron', factoryWithRealishApi) 局部覆盖验真 API drift.
vi.mock('electron-log/main', () => {
  const makeLogFns = () => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
    verbose: vi.fn(),
  });

  type ScopedLogger = ReturnType<typeof makeLogFns>;
  const scopedCache = new Map<string, ScopedLogger>();

  const log = {
    initialize: vi.fn(),
    scope: vi.fn((name: string): ScopedLogger => {
      const existing = scopedCache.get(name);
      if (existing) return existing;
      const fns = makeLogFns();
      scopedCache.set(name, fns);
      return fns;
    }),
    errorHandler: {
      startCatching: vi.fn(),
      stopCatching: vi.fn(),
    },
    transports: {
      file: {
        level: 'info' as string | false,
        resolvePathFn: undefined as unknown,
        format: '',
        archiveLogFn: vi.fn(),
        getFile: vi.fn(),
        readAllLogs: vi.fn(() => []),
        maxSize: 1024 * 1024,
      },
      console: {
        level: 'silly' as string | false,
        format: '',
        writeFn: vi.fn(),
        useStyles: false,
      },
      ipc: {
        level: false as string | false,
        eventId: '__ELECTRON_LOG__',
      },
      remote: {
        level: false as string | false,
      },
    },
    functions: makeLogFns(),
    ...makeLogFns(),
    create: vi.fn(() => log),
    Logger: vi.fn().mockImplementation(() => log),
    levels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly'],
    addLevel: vi.fn(),
    catchErrors: vi.fn(),
    hooks: [],
    variables: {},
  };

  return { default: log };
});

// ─── electron-store mock ─────────────────────────────────────────────────
// electron-store@8.2.0 是 CJS package, 顶层 `const {app, ipcMain, ipcRenderer, shell} = require('electron')`
// (node_modules/.pnpm/electron-store@8.2.0/node_modules/electron-store/index.js:3 实证).
// vitest hoist 的 vi.mock('electron') 对 ESM import 生效, 但对 CJS package 内部 require('electron')
// 拦不住 — settings-store.ts:1 `import Store from 'electron-store'` 触发 require chain → fail.
// 修法: 全局 mock electron-store 整个 module, settings-store.test.ts 的 local mock 自动覆盖
// (vitest hoist 优先级: test file local > setupFiles), 兼容性保留.
vi.mock('electron-store', () => {
  return {
    default: class MockStore<T extends Record<string, unknown> = Record<string, unknown>> {
      private data: T;
      constructor(opts?: { defaults?: T }) {
        this.data = (opts?.defaults ?? ({} as T));
      }
      get store(): T {
        return { ...this.data };
      }
      get<K extends keyof T>(key: K): T[K] {
        return this.data[key];
      }
      set<K extends keyof T>(key: K, value: T[K]): void {
        this.data[key] = value;
      }
      has<K extends keyof T>(key: K): boolean {
        return key in this.data;
      }
      delete<K extends keyof T>(key: K): void {
        delete this.data[key];
      }
      clear(): void {
        this.data = {} as T;
      }
      onDidChange(): () => void {
        return () => {};
      }
      onDidAnyChange(): () => void {
        return () => {};
      }
    },
  };
});

// ─── electron-log/renderer mock ──────────────────────────────────────────
// Plan §D15 §mock 范围 §Step 3.5.1.5 实证扩展: 原 plan §D15 写「不 mock electron-log/renderer」
// 基于「renderer 入口顶层不 require electron 安全」实证; 但 Step 3.5.1.5 实测发现 vitest 跑
// `src/renderer/utils/__tests__/logger-guard.test.ts` 时:
// 1. test file import `'../logger'` → 触发 logger.ts top-level
// 2. logger.ts `if (shouldCaptureRendererConsole(import.meta.env.MODE)) Object.assign(console, log.functions)`
// 3. vitest 处理 src/renderer/utils/logger.ts 时 `import.meta.env.MODE` 替换异常 (vitest define
//    也未拦住, 具体 root cause 不深查 — 可能与 electron-vite 多 config 拆分 + vitest 平铺 config
//    冲突), 守门返 true 跑接管
// 4. 接管后 vitest reporter 内部 console.log 经 electron-log/renderer transports/console.js setTimeout
//    macrotask 排队 → vitest stdout 失控卡死 5+ min
//
// 修法: mock 'electron-log/renderer' 整个 module → logger.ts import 时 log.functions 是 mock no-op,
// `Object.assign(console, log.functions)` 跑但不真接管 console (mock 方法都是 vi.fn() no-op).
// renderer 端业务模块测试需验真 logger 行为可在 test file local vi.unmock 覆盖.
vi.mock('electron-log/renderer', () => {
  const makeLogFns = () => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
    verbose: vi.fn(),
  });

  type ScopedLogger = ReturnType<typeof makeLogFns>;
  const scopedCache = new Map<string, ScopedLogger>();

  const log = {
    scope: vi.fn((name: string): ScopedLogger => {
      const existing = scopedCache.get(name);
      if (existing) return existing;
      const fns = makeLogFns();
      scopedCache.set(name, fns);
      return fns;
    }),
    errorHandler: {
      startCatching: vi.fn(),
      stopCatching: vi.fn(),
    },
    transports: {
      console: { level: 'silly' as string | false },
      ipc: { level: false as string | false },
    },
    functions: makeLogFns(),
    ...makeLogFns(),
    create: vi.fn(),
    Logger: vi.fn(),
  };

  return { default: log };
});
