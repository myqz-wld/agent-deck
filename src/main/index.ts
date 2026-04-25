import { app, BrowserWindow, globalShortcut } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureFocusableOnActivate, getFloatingWindow } from './window';
import { bootstrapIpc } from './ipc';
import { HookServer } from './hook-server/server';
import { RouteRegistry } from './hook-server/route-registry';
import { eventBus } from './event-bus';
import { initDb, closeDb } from './store/db';
import { settingsStore } from './store/settings-store';
import { adapterRegistry } from './adapters/registry';
import { claudeCodeAdapter } from './adapters/claude-code';
import { applyClaudeSettingsEnv } from './adapters/claude-code/settings-env';
import { codexCliAdapter } from './adapters/codex-cli';
import { aiderAdapter } from './adapters/aider';
import { genericPtyAdapter } from './adapters/generic-pty';
import { sessionManager, setSessionCloseFn } from './session/manager';
import { LifecycleScheduler, setLifecycleScheduler } from './session/lifecycle-scheduler';
import { summarizer } from './session/summarizer';
import { routeEventToNotification } from './notify/event-router';
import { stopAllSounds } from './notify/sound';
import { handleCliArgv } from './cli';
import { IpcEvent } from '@shared/ipc-channels';
import type { AgentEvent } from '@shared/types';

// 注：之前禁用过硬件加速以规避 transparent 窗口闪烁，但会让 macOS vibrancy
// 与 CSS backdrop-filter 一起失效（两者都依赖 GPU compositing），毛玻璃质感全无。
// 默认开启硬件加速；若再次出现闪烁，再针对具体显卡兜底处理。
// app.disableHardwareAcceleration();

let hookServer: HookServer;
let routeRegistry: RouteRegistry;
let scheduler: LifecycleScheduler;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

async function bootstrap(): Promise<void> {
  electronApp.setAppUserModelId('com.agentdeck.app');

  // 0. 把 ~/.claude/settings.json 的 env（代理 / Bearer token / 模型映射）注入到主进程，
  // 让 Claude Agent SDK spawn 的 CLI 子进程拿到与终端 `claude` 一致的鉴权配置。
  applyClaudeSettingsEnv();

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // 1. 数据库
  initDb();

  // 2. 设置
  const settings = settingsStore.getAll();

  // 3. HookServer + RouteRegistry。token 在 settings-store ensure() 阶段已确保非空，
  // server 的 onRequest hook 会校验所有 /hook/* 的 Authorization: Bearer <token>。
  hookServer = new HookServer(settings.hookServerPort, settings.hookServerToken ?? '');
  routeRegistry = new RouteRegistry(hookServer);

  // 4. 注册 adapter（占位 adapter 也注册，但 capabilities 决定它们不在 UI 暴露）
  adapterRegistry.register(claudeCodeAdapter);
  adapterRegistry.register(codexCliAdapter);
  adapterRegistry.register(aiderAdapter);
  adapterRegistry.register(genericPtyAdapter);

  // 5. 把 adapter 发出的 AgentEvent 接入 SessionManager
  await adapterRegistry.initAll({
    hookServer,
    routeRegistry,
    emit: (event: AgentEvent) => {
      sessionManager.ingest(event);
      // 通知路由抽离到 notify/event-router.ts（CHANGELOG_20 / F）：
      // bootstrap 回归装配胶水职责，新增 kind→通知规则只动 routeEventToNotification。
      routeEventToNotification(event);
    },
    paths: {
      userHome: homedir(),
      userClaudeSettings: join(homedir(), '.claude', 'settings.json'),
    },
  });

  // 5.1 注入「会话删除时关 SDK 侧 live query」hook（CHANGELOG_20 / N2）。
  // SessionManager 不感知 adapterRegistry（单职责），通过 setter 注入。
  setSessionCloseFn(async (agentId, sessionId) => {
    const adapter = adapterRegistry.get(agentId);
    if (!adapter?.closeSession) return;
    await adapter.closeSession(sessionId);
  });

  // 6. 启动 HookServer
  try {
    await hookServer.start();
    console.log(`[hook-server] listening on 127.0.0.1:${hookServer.listeningPort}`);
  } catch (err) {
    console.error('[hook-server] failed to start', err);
  }

  // 7. 启动生命周期调度器与总结器
  scheduler = new LifecycleScheduler({
    activeWindowMs: settings.activeWindowMs,
    closeAfterMs: settings.closeAfterMs,
    historyRetentionDays: settings.historyRetentionDays,
  });
  scheduler.start();
  setLifecycleScheduler(scheduler);
  summarizer.start();

  // 7.1 开机自启：每次启动同步设置（用户在 UI 关掉时也要能取消注册）。
  // dev 模式下跑的是未签名的 Electron 二进制，macOS 13+ 直接拒绝写入登录项，
  // 错误是原生层 LOG(ERROR) 打到 stderr，try/catch 接不住，因此 dev 直接跳过。
  if (!is.dev && (process.platform === 'darwin' || process.platform === 'win32')) {
    app.setLoginItemSettings({
      openAtLogin: settings.startOnLogin,
      openAsHidden: false,
    });
  }

  // 8. IPC
  bootstrapIpc();

  // 9. 创建窗口并把事件总线接到 webContents
  const floating = getFloatingWindow();
  floating.create();
  // 启动时同步「pin 时是否透明」到 window 内部 state；window 启动时窗口 alwaysOnTop=true，
  // 此调用会顺带按 settings.transparentWhenPinned 决定 vibrancy 初值（true=null / false=under-window）。
  floating.setTransparentWhenPinned(settings.transparentWhenPinned);
  // 通过 floating.window 动态拿当前活窗口 + isDestroyed 兜底：
  // macOS 关闭窗口但进程不退（window-all-closed 不 quit），listener 闭包持有的旧 win
  // 已 destroyed；scheduler / IPC 仍会触发 eventBus，调用 webContents.send 会抛
  // "Object has been destroyed"。Activate 重建窗口时也能让事件继续投递到新 win。
  const safeSend = <T>(channel: string, payload: T): void => {
    const w = floating.window;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(channel, payload);
  };
  eventBus.on('agent-event', (e) => safeSend(IpcEvent.AgentEvent, e));
  eventBus.on('session-upserted', (s) => safeSend(IpcEvent.SessionUpserted, s));
  eventBus.on('session-removed', (id) => safeSend(IpcEvent.SessionRemoved, id));
  eventBus.on('session-renamed', (p) => safeSend(IpcEvent.SessionRenamed, p));
  eventBus.on('summary-added', (s) => safeSend(IpcEvent.SummaryAdded, s));
  eventBus.on('session-focus-request', (sid) => safeSend(IpcEvent.SessionFocusRequest, sid));

  ensureFocusableOnActivate();

  // 10. 全局快捷键：Cmd/Ctrl+Alt+P 切换 pin（窗口置顶 + vibrancy）。
  // 通过 IPC 把新状态推回 renderer，UI 与持久化同步更新。
  const pinShortcut = 'CommandOrControl+Alt+P';
  const registered = globalShortcut.register(pinShortcut, () => {
    const w = floating.window;
    if (!w || w.isDestroyed()) return;
    const next = !w.isAlwaysOnTop();
    floating.setAlwaysOnTop(next);
    safeSend(IpcEvent.PinToggled, next);
  });
  if (!registered) {
    console.warn(`[shortcut] failed to register ${pinShortcut} (occupied by another app)`);
  }

  // 11. 首启命令行：bootstrap 全部就绪后再处理。
  // renderer 还没挂载也没关系 —— focus-request 事件会被 webContents.send 排队，
  // 等 renderer mount + 注册 onSessionFocusRequest 后能收到。但更重要的是先等
  // adapterRegistry.initAll 完成（已在 step 5 完成），否则 createSession 会报错。
  // 用 setImmediate 让 bootstrap 函数本身尽快返回，错误也只走弹框，不阻塞启动。
  setImmediate(() => {
    void handleCliArgv(process.argv);
  });
}

app.whenReady().then(() => {
  bootstrap().catch((err) => console.error('bootstrap failed', err));
});

app.on('second-instance', (_event, argv) => {
  // 把第二实例的窗口拉前来，再尝试解析命令行。两件事互不阻塞。
  const all = BrowserWindow.getAllWindows();
  if (all.length) {
    all[0].show();
    all[0].focus();
  }
  void handleCliArgv(argv);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// CHANGELOG_47：before-quit listener 不是 promise-aware，原来的 async () => { await ... }
// 里 await 形同摆设，Electron 不会等回调返回的 Promise。改成 preventDefault → 真异步清理 → app.exit()。
// `cleaningUp` 防止 app.exit() 内部再触发 before-quit 时进入死循环。
let cleaningUp = false;
app.on('before-quit', (event) => {
  if (cleaningUp) return;
  event.preventDefault();
  cleaningUp = true;
  void (async () => {
    try {
      globalShortcut.unregisterAll();
      scheduler?.stop();
      setLifecycleScheduler(null);
      summarizer.stop();
      stopAllSounds();
      await adapterRegistry.shutdownAll();
      try {
        await hookServer?.stop();
      } catch {
        // ignore: 已经在退出，hookServer.stop() 失败不可补救
      }
      closeDb();
    } catch (err) {
      console.warn('[before-quit] cleanup error', err);
    } finally {
      app.exit(0);
    }
  })();
});
