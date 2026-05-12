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
import { LifecycleScheduler, setLifecycleScheduler } from './session/lifecycle-scheduler';
import { summarizer } from './session/summarizer';
import { routeEventToNotification } from './notify/event-router';
import { stopAllSounds } from './notify/sound';
import { handleCliArgv } from './cli';
import { setAgentDeckMcpTokenEnv } from './codex-config/agent-deck-mcp-injector';
// NOTE(REVIEW_<X>)：以下两个 codex-config 模块**必须**走 static import，不要改回 dynamic import。
// 同一模块在多处 dynamic import（index.ts × 2 + ipc/settings.ts × 3）会让 vite SSR/rollup 把模块代码 inline
// 进主 index.js，独立 chunk 文件只剩 require 空壳没有 export → 运行时 dynamic import 拿到空对象 →
// 「X is not a function」（dev 模式 ESM 直 import 测不出，只在打包后炸）。两个模块顶部都纯 import + export
// function，无副作用，static import 等价。
import { syncAgentDeckSection } from './codex-config/agents-md-installer';
import { syncSkills } from './codex-config/skills-installer';
import { universalMessageWatcher } from './teams/universal-message-watcher';
import { IpcEvent } from '@shared/ipc-channels';
import { reapStaleUploads } from './store/image-uploads';
import type { AgentEvent } from '@shared/types';

// 防止 packaged GUI 模式下 stdout/stderr 管道被对端关闭时，console.log/error 抛出
// EPIPE 升级为 uncaughtException 把 main 进程整个挂掉。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

let hookServer: HookServer;
let routeRegistry: RouteRegistry;
let scheduler: LifecycleScheduler;
let agentDeckMcpHttpShutdown: (() => Promise<void>) | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ────────────────────────────────────────────────────────────────────────────
// R3.E9 IPC bridge debouncer：team / message events 16ms debounce + per-team 累加
// （reviewer claude LOW 收口）。burst 投递时 renderer 不会被高频重渲染。
// ────────────────────────────────────────────────────────────────────────────

function makeDebouncedTeamSender<T>(
  channel: string,
  send: (channel: string, payload: T[]) => void,
  pickKey: (item: T) => string,
): (item: T) => void {
  const state: { pending: Map<string, T>; timer: NodeJS.Timeout | null } = {
    pending: new Map(),
    timer: null,
  };
  return (item: T) => {
    state.pending.set(pickKey(item), item);
    if (state.timer) return;
    state.timer = setTimeout(() => {
      const items = Array.from(state.pending.values());
      state.pending.clear();
      state.timer = null;
      if (items.length === 0) return;
      send(channel, items);
    }, 16);
  };
}

async function bootstrap(): Promise<void> {
  electronApp.setAppUserModelId('com.agentdeck.app');

  // 0. 把 ~/.claude/settings.json 的 env 注入到主进程
  applyClaudeSettingsEnv();

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // 1. 数据库
  initDb();

  // 2. 设置
  const settings = settingsStore.getAll();

  // 3. HookServer + RouteRegistry
  hookServer = new HookServer(
    settings.hookServerPort,
    settings.hookServerToken ?? '',
    settings.mcpServerToken ?? '',
  );
  routeRegistry = new RouteRegistry(hookServer);

  // 4. 注册 adapter
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
      routeEventToNotification(event);
    },
    paths: {
      userHome: homedir(),
      userClaudeSettings: join(homedir(), '.claude', 'settings.json'),
    },
  });

  // 5.1 注入「会话删除时关 SDK 侧 live query」hook
  setSessionCloseFn(async (agentId, sessionId) => {
    const adapter = adapterRegistry.get(agentId);
    if (!adapter?.closeSession) return;
    await adapter.closeSession(sessionId);
  });

  // 5.5. R2 / B'4 + R1.A5 + R1.D7：Agent Deck MCP server 自动启停（PRE_LISTEN 阶段）
  // **必须在 hookServer.start() 之前注册 routes**，否则 fastify 5.x 在 listen 后调
  // app.route() 会抛 FST_ERR_INSTANCE_ALREADY_LISTENING（lib/route.js:208
  // throwIfAlreadyStarted）→ MCP HTTP /mcp 完全不挂 → codex / 外部 MCP client 连不上。
  // 详见 REVIEW_27 / CHANGELOG_70（cdb01ae 引入时位置错了，本次前移收口）。
  // - 把 mcpServerToken 设进 process.env，让后续 spawn 的 codex 子进程继承后能 readEnv
  //   AGENT_DECK_MCP_TOKEN（agent-deck-mcp-injector 写入 codex SDK config 的
  //   bearer_token_env_var = 'AGENT_DECK_MCP_TOKEN'）
  // - 双开关同 ON 时挂 HTTP /mcp 路由（StreamableHTTPServerTransport），让 codex /
  //   外部 MCP client 能连
  setAgentDeckMcpTokenEnv(settings.mcpServerToken ?? null);
  if (settings.enableAgentDeckMcp && settings.mcpHttpEnabled) {
    try {
      const { registerAgentDeckMcpHttpRoutes } = await import(
        './agent-deck-mcp/transport-http'
      );
      const handle = await registerAgentDeckMcpHttpRoutes(routeRegistry);
      agentDeckMcpHttpShutdown = handle.shutdown;
      console.log('[agent-deck-mcp] HTTP transport mounted at /mcp');
    } catch (err) {
      console.error('[agent-deck-mcp] failed to mount HTTP transport', err);
    }
  }

  // 6. 启动 HookServer（POST_LISTEN 分水岭：此行之后任何 routeRegistry /
  // registerRoute 调用都会被 HookServer.registerRoute 的 invariant 拒）
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

  // 7.0 D1+D2：app ready 后同步 Agent Deck 段到 ~/.codex/AGENTS.md + skills
  // syncAgentDeckSection / syncSkills 走 static import（顶部 import 段已说明原因），
  // 这里同步直接调；失败只 warn 不抛（不阻断 main 启动），与 settings.ts 同步路径同模式。
  try {
    syncAgentDeckSection();
  } catch (err) {
    console.warn('[bootstrap] syncAgentDeckSection 失败', err);
  }
  try {
    syncSkills();
  } catch (err) {
    console.warn('[bootstrap] syncSkills 失败', err);
  }

  // 7.05 R3.E5：universal-message-watcher 启动（cross-adapter team message 投递）
  universalMessageWatcher.start();

  // 7.1 开机自启
  if (!is.dev && (process.platform === 'darwin' || process.platform === 'win32')) {
    app.setLoginItemSettings({
      openAtLogin: settings.startOnLogin,
      openAsHidden: false,
    });
  }

  // 8. IPC
  bootstrapIpc();

  // 8.5 预热 agent-deck plugin 内置 agents/skills frontmatter 缓存
  try {
    loadBundledAssets();
  } catch (err) {
    console.warn('[main] loadBundledAssets failed:', err);
  }

  // 8.6 image-uploads reaper：清掉 14 天前的孤儿附件文件
  void reapStaleUploads();

  // 9. 创建窗口并把事件总线接到 webContents
  const floating = getFloatingWindow();
  floating.create();
  floating.setTransparentWhenPinned(settings.transparentWhenPinned);
  const safeSend = <T>(channel: string, payload: T): void => {
    const w = floating.window;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(channel, payload);
  };
  eventBus.on('agent-event', (e) => safeSend(IpcEvent.AgentEvent, e));
  // plan team-cohesion-fix-20260513 Phase A：桥到 renderer 前 enrichWithTeams 把 universal team
  // backend membership 拼到 SessionRecord.teams[]，让 SessionCard / PendingTab / TeamDetail
  // 拿到 lead/teammate 角色 + teamName 不再依赖老 sessions.team_name 列。
  eventBus.on('session-upserted', (s) => safeSend(IpcEvent.SessionUpserted, sessionManager.enrichWithTeams(s)));
  eventBus.on('session-removed', (id) => safeSend(IpcEvent.SessionRemoved, id));
  eventBus.on('session-renamed', (p) => safeSend(IpcEvent.SessionRenamed, p));
  eventBus.on('summary-added', (s) => safeSend(IpcEvent.SummaryAdded, s));
  eventBus.on('session-focus-request', (sid) => safeSend(IpcEvent.SessionFocusRequest, sid));

  // Task Manager (CHANGELOG_43)：tasks 表写操作 → renderer
  eventBus.on('task-changed', (p) => safeSend(IpcEvent.TaskChanged, p));

  // ─── R3.E9 universal team backend → renderer 桥接 ───
  // team 增删改 / member 改：聚合到 IpcEvent.AgentDeckTeamChanged
  // message 状态变迁 / 入队：聚合到 IpcEvent.AgentDeckMessageChanged
  // 16ms debounce + per-team 累加合并（reviewer claude LOW 收口）
  const teamChangedSender = makeDebouncedTeamSender<{ kind: string; teamId: string; payload: unknown }>(
    IpcEvent.AgentDeckTeamChanged,
    safeSend,
    (item) => `${item.kind}:${item.teamId}`,
  );
  eventBus.on('agent-deck-team-created', (team) =>
    teamChangedSender({ kind: 'created', teamId: team.id, payload: team }),
  );
  eventBus.on('agent-deck-team-updated', (team) =>
    teamChangedSender({ kind: 'updated', teamId: team.id, payload: team }),
  );
  eventBus.on('agent-deck-team-deleted', (p) =>
    teamChangedSender({ kind: 'deleted', teamId: p.id, payload: p }),
  );
  eventBus.on('agent-deck-team-member-changed', (p) =>
    teamChangedSender({ kind: `member-${p.kind}`, teamId: p.teamId, payload: p }),
  );

  const messageChangedSender = makeDebouncedTeamSender<{ kind: string; teamId: string; messageId: string; payload: unknown }>(
    IpcEvent.AgentDeckMessageChanged,
    safeSend,
    (item) => `${item.kind}:${item.messageId}`,
  );
  eventBus.on('agent-deck-message-enqueued', (p) =>
    messageChangedSender({ kind: 'enqueued', teamId: p.teamId, messageId: p.id, payload: p }),
  );
  eventBus.on('agent-deck-message-status-changed', (p) =>
    messageChangedSender({ kind: 'status-changed', teamId: p.teamId, messageId: p.id, payload: p }),
  );

  ensureFocusableOnActivate();

  // 10. 全局快捷键：Cmd/Ctrl+Alt+P 切换 pin
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

  // 10.5 全局快捷键：Cmd/Ctrl+Alt+T 切换「pin 时透明」开关
  // 与 Cmd+Alt+P 命名一致（Cmd+Alt+<X> 都是窗口控制）；避开浏览器 Cmd+Shift+T（重开关闭标签页）。
  // floating.setTransparentWhenPinned 是 idempotent，settings handler 走 setSettings 时还会再调一次安全。
  const transparentShortcut = 'CommandOrControl+Alt+T';
  const transparentRegistered = globalShortcut.register(transparentShortcut, () => {
    const w = floating.window;
    if (!w || w.isDestroyed()) return;
    const next = !(settingsStore.get('transparentWhenPinned') ?? true);
    floating.setTransparentWhenPinned(next);
    safeSend(IpcEvent.TransparentToggled, next);
  });
  if (!transparentRegistered) {
    console.warn(`[shortcut] failed to register ${transparentShortcut} (occupied by another app)`);
  }

  // 11. 首启命令行
  setImmediate(() => {
    void handleCliArgv(process.argv);
  });
}

app.whenReady().then(() => {
  bootstrap().catch((err) => console.error('bootstrap failed', err));
});

app.on('second-instance', (_event, argv) => {
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
      // R3.E5：universal-message-watcher shutdown
      universalMessageWatcher.stop();
      await adapterRegistry.shutdownAll();
      if (agentDeckMcpHttpShutdown) {
        try {
          await agentDeckMcpHttpShutdown();
        } catch (err) {
          console.warn('[agent-deck-mcp] HTTP shutdown failed during cleanup', err);
        }
        agentDeckMcpHttpShutdown = null;
      }
      try {
        await hookServer?.stop();
      } catch {
        // ignore: 已经在退出
      }
      closeDb();
    } catch (err) {
      console.warn('[before-quit] cleanup error', err);
    } finally {
      app.exit(0);
    }
  })();
});
