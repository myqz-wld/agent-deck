import { app, BrowserWindow, globalShortcut } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureFocusableOnActivate, getFloatingWindow } from './window';
import { bootstrapIpc } from './ipc';
import { loadBundledAssets } from './bundled-assets';
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
import { sessionRepo } from './store/session-repo';
import { LifecycleScheduler, setLifecycleScheduler } from './session/lifecycle-scheduler';
import { summarizer } from './session/summarizer';
import { routeEventToNotification } from './notify/event-router';
import { stopAllSounds } from './notify/sound';
import { handleCliArgv } from './cli';
import { teamWatcher } from './teams/team-watcher';
import { inboxWatcher } from './teams/inbox-watcher';
import { teamCoordinator } from './teams/team-coordinator';
import { translateTeamPermissionCancelled, translateTeamPermissionRequest } from './adapters/claude-code/translate';
import { IpcEvent } from '@shared/ipc-channels';
import { reapStaleUploads } from './store/image-uploads';
import type { AgentEvent } from '@shared/types';

// 防止 packaged GUI 模式下 stdout/stderr 管道被对端关闭时，console.log/error 抛出
// EPIPE 升级为 uncaughtException 把 main 进程整个挂掉（实测：wrapper exec
// Electron stub 启动后，window.ts showOnce 的 console.log 即触发 EPIPE，main 直接退）。
// 仅吞 stdout/stderr 写错误，不接管其他 uncaughtException 语义。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

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

  // 8.5 预热 agent-deck plugin 内置 agents/skills frontmatter 缓存（CHANGELOG_57）。
  //     在 bootstrapIpc 之后跑：handler 已注册，AssetsListBundled 立刻可走缓存零开销。
  //     失败仅 console.warn，UI 层 listBundledAssets 拿到空清单不致命。
  try {
    loadBundledAssets();
  } catch (err) {
    console.warn('[main] loadBundledAssets failed:', err);
  }

  // 8.6 image-uploads reaper：清掉 14 天前的孤儿附件文件。
  //     fire-and-forget：不阻塞启动；失败 console.warn 内部已处理，不抛。
  //     14 天阈值理由：events 行 historyRetentionDays 默认 30 天，reaper 阈值 ≤ retention
  //     保证「events 行还在但 attachment 已被清」可能发生（UploadedImageThumb 灰底兜底），
  //     反过来不会出现孤儿堆积。
  void reapStaleUploads();

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
  // Agent Teams M2：team-watcher emit 的 fs 变化桥接到 renderer。
  // payload: { name: string, kind: 'config'|'task-list'|'unlinked' }
  //
  // M3 C 方案：kind === 'unlinked'（整个 team 目录被删 - Claude TeamDelete /
  // 用户 force-cleanup / 外部 rm -rf）→ 自动 unset 该 team 名下所有 sessions
  // 的 team_name；让 TeamHub 自然从 list 移除（distinctTeamNames 不再返回该 name），
  // 同时 emit session-upserted 让 renderer SessionCard 的 team chip 也消失。
  // sessions 本身不删，历史 tab 仍能找到。
  //
  // REVIEW_17 R1 / M6：走 teamCoordinator.unsetTeamFromAllSessions 收口（force-cleanup
  // IPC handler 走同一函数，30s dedup 让两路触发的第二次 SELECT/UPDATE 直接 no-op）。
  eventBus.on('team-data-changed', (p) => {
    if (p.kind === 'unlinked') {
      teamCoordinator.unsetTeamFromAllSessions(p.name);
    }
    safeSend(IpcEvent.TeamDataChanged, p);
  });

  // Task Manager (CHANGELOG_43)：tools.ts handler 在 task_create / task_update /
  // task_delete 写完 repo 后 emit；这里桥接到 IPC 推 renderer。当前 renderer 没 task
  // UI 消费，但基础设施有了，未来加 Tasks tab 直接 onTaskChanged 订阅即可（与
  // onTeamDataChanged 同模式）。
  eventBus.on('task-changed', (p) => safeSend(IpcEvent.TaskChanged, p));

  // Team Coordinator (CHANGELOG_46)：fs root watcher 监听 ~/.claude/teams/*/config.json
  // add/change，反向同步 team_name 到 sessions DB 列（fs 通道，PreToolUse hook 拦截路径
  // 在 hook-routes.ts 内部直接调，不在 index.ts 桥接）。
  // hook 通道（TaskCreated/TaskCompleted/TeammateIdle）也走同款 sync 调用，由 hook-routes
  // 内部触发，本处只起 fs watcher。
  teamCoordinator.startFsWatcher();

  // Inbox Watcher (CHANGELOG_45)：teammate 在 inbox 写 permission_request 被识别后
  // emit。两条桥接：
  // 1. 独立通道 IpcEvent.TeamPermissionRequested 给 TeamDetail / 全 team 视角订阅
  // 2. 转 AgentEvent waiting-for-user kind 走 IpcEvent.AgentEvent 通路，复用 PendingTab
  //    现有的 by-session pending 渲染机制（sessionId 用 team 的 lead session id 占位）
  eventBus.on('team-permission-requested', (req) => {
    safeSend(IpcEvent.TeamPermissionRequested, req);
    const sessions = sessionRepo.findByTeamName(req.teamName);
    // lead session 优先（source='sdk' 且 active），找不到任意 active session 兜底；
    // 都没有就直接丢（理论上 inbox 文件存在但没 active session 不会发生）
    const leadSession =
      sessions.find((s) => s.source === 'sdk' && s.lifecycle === 'active') ??
      sessions.find((s) => s.lifecycle === 'active') ??
      sessions[0];
    if (!leadSession) {
      console.warn(
        `[main] team-permission-requested for "${req.teamName}" but no session bound; UI 看不到。`,
      );
      return;
    }
    const ev = translateTeamPermissionRequest(req, leadSession.id);
    sessionManager.ingest(ev);
  });
  // 用户 UI 响应完后清掉 renderer pending 列表
  eventBus.on('team-permission-resolved', (p) => safeSend(IpcEvent.TeamPermissionResolved, p));
  // teammate 自己 abort permission（inbox-watcher 检测到 idle_notification 触发）
  // → 复用 team-permission-resolved IPC 通道清 pending（payload schema 兼容：都有
  //    teamName + requestId），同时走 AgentEvent 通路让 activity-feed 留 cancelled marker
  eventBus.on('team-permission-cancelled', (cancel) => {
    // 1. 通知所有 renderer 把 pendingTeamPermissions 列表里这条删掉（按钮变灰不可点）
    safeSend(IpcEvent.TeamPermissionResolved, {
      teamName: cancel.teamName,
      requestId: cancel.requestId,
    });
    // 2. 走 AgentEvent 通路让 lead session 的 activity-feed 留一条 cancelled event 标灰
    const sessions = sessionRepo.findByTeamName(cancel.teamName);
    const leadSession =
      sessions.find((s) => s.source === 'sdk' && s.lifecycle === 'active') ??
      sessions.find((s) => s.lifecycle === 'active') ??
      sessions[0];
    if (!leadSession) return;
    sessionManager.ingest(translateTeamPermissionCancelled(cancel, leadSession.id));
  });

  // Inbox Watcher 自动订阅：team_name 非空 + lifecycle=active 的 sessions 对应 team
  // 自动订阅 inbox watcher。两个入口：
  // 1. bootstrap 末尾扫一次现存 sessions
  // 2. session-upserted 事件回调里同步订阅 / 取消订阅
  // 用一个 Set 记录「应用内已订阅过的 team」，避免重复 subscribe（refcount 会涨但 inbox-watcher
  // 自带去重 grace；不过我们这里不希望 ref 涨—— bootstrap 期间一次性 subscribe，到关闭时
  // unsubscribe）。
  const autoSubscribedTeams = new Set<string>();
  const refreshAutoSubscribe = (): void => {
    const wantTeams = new Set<string>();
    // 只订阅活跃 sessions（active 或 dormant）所属的 team；closed 不订阅，避免长期沉睡的
    // team inbox 一直挂 watcher。
    for (const s of sessionRepo.listActiveAndDormant()) {
      if (s.teamName && s.teamName.trim()) wantTeams.add(s.teamName);
    }
    // 新增：want - already
    for (const t of wantTeams) {
      if (!autoSubscribedTeams.has(t)) {
        inboxWatcher.subscribe(t);
        autoSubscribedTeams.add(t);
      }
    }
    // 移除：already - want
    for (const t of autoSubscribedTeams) {
      if (!wantTeams.has(t)) {
        inboxWatcher.unsubscribe(t);
        autoSubscribedTeams.delete(t);
      }
    }
  };
  // bootstrap 时同步一次（应用启动时就有的 active session）
  refreshAutoSubscribe();
  // session 变化（新建 / lifecycle 变 / team_name 变）时重算订阅集
  eventBus.on('session-upserted', () => refreshAutoSubscribe());
  eventBus.on('session-removed', () => refreshAutoSubscribe());
  eventBus.on('session-renamed', () => refreshAutoSubscribe());

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
      // Agent Teams M2：close 所有 chokidar watcher，防 fs handle 阻塞进程退出
      await teamWatcher.shutdownAll();
      // CHANGELOG_45：inbox watcher 同款 shutdown
      await inboxWatcher.shutdownAll();
      // CHANGELOG_46：team-coordinator fs root watcher shutdown
      await teamCoordinator.shutdown();
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
