import { app, BrowserWindow, dialog, globalShortcut } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureFocusableOnActivate, getFloatingWindow } from './window';
import { bootstrapIpc } from './ipc';
import { loadBundledAssets } from './bundled-assets';
import { HookServer } from './hook-server/server';
import { RouteRegistry } from './hook-server/route-registry';
import { eventBus } from './event-bus';
import type { EventMap } from './event-bus';
import { initDb, closeDb } from './store/db';
import { settingsStore } from './store/settings-store';
import { adapterRegistry } from './adapters/registry';
import { claudeCodeAdapter } from './adapters/claude-code';
import { applyClaudeSettingsEnv } from './adapters/claude-code/settings-env';
import { codexCliAdapter } from './adapters/codex-cli';
import { sessionManager, setSessionCloseFn, setSessionRenameHookFn } from './session/manager';
import { LifecycleScheduler, setLifecycleScheduler } from './session/lifecycle-scheduler';
import {
  TeamLifecycleScheduler,
  setTeamLifecycleScheduler,
} from './teams/team-lifecycle-scheduler';
import { summarizer } from './session/summarizer';
import { routeEventToNotification } from './notify/event-router';
import { notifyUser } from './notify/visual';
import { stopAllSounds } from './notify/sound';
import { handleCliArgv } from './cli';
import { AGENT_DECK_MCP_TOKEN_ENV } from './codex-config/agent-deck-mcp-injector';
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
let teamScheduler: TeamLifecycleScheduler;
let agentDeckMcpHttpShutdown: (() => Promise<void>) | null = null;

const gotLock = app.requestSingleInstanceLock();
// 锁失败立即 quit；后续 listener 注册全部隔离到 if (gotLock) { ... } 分支（line 316+）
// 防止第二实例进 bootstrap 副作用（initDb / hookServer / IPC handler 重复注册）。
// REVIEW_35 MED-D-claude（HIGH→MED 降级 by codex 反驳）。
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

  // 5.1.1 plan codex-handoff-team-alignment-20260518 P2 Step 2.8 / 不变量 7：注入 rename hook
  // 让 sessionManager.renameSdkSession 函数体内统一调到 codex bridge.renameCodexInstance,
  // 同步 rename codexBySession Map key(token map / sessions Map / sdkOwned 三处 key 已经
  // 在 renameSdkSession 内同步迁移,本 hook 补 codex bridge per-session 实例 Map 第四处)。
  // claude bridge 不需要 hook(in-process MCP transport closure override,不消费 token map),
  // 命中 agentId === 'claude-code' 时 noop 退出。
  setSessionRenameHookFn((agentId, fromId, toId) => {
    if (agentId !== 'codex-cli') return;
    const adapter = adapterRegistry.get(agentId);
    // adapter.bridge 不在 AdapterCapabilities 标准接口上,需类型探测。codex adapter 暴露
    // codexCliBridge 实例(详 src/main/adapters/codex-cli/index.ts setup),里面有 renameCodexInstance
    // public method(plan P2 Step 2.5)。
    const bridge = (adapter as { bridge?: { renameCodexInstance?: (a: string, b: string) => void } })
      ?.bridge;
    if (!bridge?.renameCodexInstance) return;
    bridge.renameCodexInstance(fromId, toId);
  });

  // 5.5. R2 / B'4 + R1.A5 + R1.D7：Agent Deck MCP server 自动启停（PRE_LISTEN 阶段）
  // **必须在 hookServer.start() 之前注册 routes**，否则 fastify 5.x 在 listen 后调
  // app.route() 会抛 FST_ERR_INSTANCE_ALREADY_LISTENING（lib/route.js:208
  // throwIfAlreadyStarted）→ MCP HTTP /mcp 完全不挂 → codex / 外部 MCP client 连不上。
  // 详见 REVIEW_27 / CHANGELOG_70（cdb01ae 引入时位置错了，本次前移收口）。
  // - 把 mcpServerToken 设进 process.env 当全局 fallback token（plan codex-handoff-team-alignment-20260518
  //   D1 §(c) 共存策略）：per-session codex teammate 通过 envOverride 注入自己的 session token
  //   走 mcpSessionTokenMap 反查 sid（sdk-bridge ensureCodex per-session 路径）；外部 codex CLI /
  //   非应用 spawn 路径继承全局 process.env.AGENT_DECK_MCP_TOKEN 走全局 fallback token →
  //   HookServer.checkMcpAuth 走 fallbackToGlobal=true 路径让 handler 视为 external caller
  //   （EXTERNAL_CALLER_ALLOWED 表只允许 list/get,spawn/send/shutdown 全 deny）。
  //   一次性设,运行时不再 mutate（删 setAgentDeckMcpTokenEnv setter,P2 Step 2.6）。
  // - 双开关同 ON 时挂 HTTP /mcp 路由（StreamableHTTPServerTransport），让 codex /
  //   外部 MCP client 能连
  if (settings.mcpServerToken && settings.mcpServerToken.length > 0) {
    process.env[AGENT_DECK_MCP_TOKEN_ENV] = settings.mcpServerToken;
  } else {
    delete process.env[AGENT_DECK_MCP_TOKEN_ENV];
  }
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
    // REVIEW_35 follow-up rH R2-M4: HookServer 是 hooks/MCP 通道的根基，启动失败不能让应用
    // 半启动（旧版只 console.error 后继续 → scheduler/IPC/window 正常起，hooks 通道全挂但
    // UI 无明确错误）。EADDRINUSE 典型场景：上次崩溃 / 另一实例残留 / 端口被占用。
    // fail-loud：dialog.showErrorBox 同步反馈用户 + app.exit(1) 释放单实例锁让用户能改端口重启。
    console.error('[hook-server] failed to start', err);
    const reason = err instanceof Error ? err.message : String(err);
    const isAddrInUse = /EADDRINUSE/i.test(reason);
    try {
      dialog.showErrorBox(
        'Agent Deck 启动失败 — Hook 服务无法绑定端口',
        isAddrInUse
          ? `端口 ${hookServer.listeningPort} 被占用（EADDRINUSE）。\n\n可能原因：\n` +
            `• 另一个 Agent Deck 实例残留（请检查任务管理器 / Activity Monitor 杀掉旧进程）\n` +
            `• 该端口被其他应用占用\n\n` +
            `修法：在 ~/.claude/agent-deck/settings.json 改 hookServerPort 后重启。\n\n` +
            `详细错误：\n${reason.slice(0, 500)}`
          : `Hook 服务启动失败：${reason.slice(0, 1000)}`,
      );
    } catch (dialogErr) {
      console.error('showErrorBox failed during hook-server EADDRINUSE:', dialogErr);
    }
    // REVIEW_61 MED-B (codex) fix: app.exit(1) 不发 before-quit/will-quit (Electron 文档),
    // before-quit handler line 519 不会跑 → closeDb() 不会执行 → SQLite WAL 不 checkpoint。
    // initDb 已在 line 99 跑过,WAL 可能有未 checkpoint 的写入(applyClaudeSettingsEnv /
    // settings 读 / adapter init 都可能触发 SELECT/UPDATE)。fatal exit 前同步 best-effort
    // 跑 closeDb,失败仅 warn 不阻塞 exit(本来就是 fatal 路径,WAL 丢一点比 hang 住强)。
    try {
      closeDb();
    } catch (err) {
      console.warn('[hook-server fatal] closeDb error', err);
    }
    app.exit(1);
    return;
  }

  // 7. 启动生命周期调度器与总结器
  scheduler = new LifecycleScheduler({
    activeWindowMs: settings.activeWindowMs,
    closeAfterMs: settings.closeAfterMs,
    historyRetentionDays: settings.historyRetentionDays,
  });
  scheduler.start();
  setLifecycleScheduler(scheduler);
  // plan team-cohesion-fix-20260513 Phase F D7：team 生命周期 scheduler。5min 周期 +
  // 30min grace。lead 经过 D6 路径自动 archive 是主路径；本 scheduler 是兜底（程序
  // ungraceful 退出 / hook 绕过 sessionManager 的场景定期清理幽灵 team）。
  teamScheduler = new TeamLifecycleScheduler();
  teamScheduler.start();
  setTeamLifecycleScheduler(teamScheduler);
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
  floating.setWindowTransparent(settings.windowTransparent);
  const safeSend = <T>(channel: string, payload: T): void => {
    const w = floating.window;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(channel, payload);
  };
  // CHANGELOG_124 R1 fix REVIEW_45 MED-1：toggleMaximize / toggleDefault 退出 compact 态时
  // 通过此回调 emit IpcEvent.CompactToggled，让 renderer App.tsx 同步本地 compact state，
  // 避免按钮 label `{compact ? '▢' : '─'}` 与窗口实际尺寸反转。
  floating.emitCompactChanged = (compact) => safeSend(IpcEvent.CompactToggled, compact);
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

  // ─── archive-failure-ux-upthrow-20260515 plan: caller archive 失败 UX 上抛 ───
  // 触发源 3 处:
  // 1. mcp baton-cleanup row-missing 短路 (toolName='archive_plan' / 'hand_off_session', reasonKind='row-missing')
  // 2. mcp baton-cleanup archiveFn 抛错 (toolName 同上, reasonKind='archive-throw')
  // 3. K3 SessionHandOffSpawn archive 抛错或 row-missing (toolName='SessionHandOffSpawn', reasonKind 区分)
  //
  // listener 双通道桥接:
  // - notifyUser({level:'info'}) — macOS 系统通知,settings.enableSystemNotification 开启时显示;
  //   reasonKind 区分文案: 'archive-throw' 提示「可重试归档」/ 'row-missing' 提示「记录已不可用」
  // - safeSend(IpcEvent.CallerArchiveFailed) — IPC 上抛 renderer,P2 enhancement 可挂全局 toast
  //   + 「重试归档」按钮(reasonKind='archive-throw' 显示 / 'row-missing' 仅告知)
  //
  // R2 reviewer-claude HIGH-1 + reviewer-codex HIGH 双方共识守门: listener 顶部必须包 try/catch。
  // notifyUser (visual.ts) 没自己 try/catch — 内部调 settingsStore.getAll / Notification.isSupported /
  // new Notification(...).show / playSoundOnce 任一抛错都会冒泡;safeSend (line 252) 也没 catch。
  // Node EventEmitter 行为: listener throw 在 sync emit 中会冒泡到 emit 调用方,并阻塞同 emit
  // 上后续 listener。如果 listener throw,baton-cleanup / archiveSourceSessionWithEmit 内的 emitFn
  // 调用会 reject → mcp tool 在核心操作已成功后返回失败 / K3 跳过 session-focus-request + newSid
  // 返回,把「archive 失败 warn-only 不阻塞 caller」硬不变量彻底搞反 (UX 上抛通道反成 UX 倒灌通道)。
  // 修法: listener 顶层 try/catch + console.error 兜底,零成本守住不变量。
  //
  // R2 reviewer-claude MED-1 守门: payload.toolName 含三种值 ('archive_plan' / 'hand_off_session' /
  // 'SessionHandOffSpawn'),其中前两个是 mcp tool 名 (用户在 codex/claude 调用 mcp tool 时熟悉),
  // 'SessionHandOffSpawn' 是 IPC channel 内部名 (IpcInvoke.SessionHandOffSpawn = 'session:hand-off-spawn',
  // 用户在 UI 看不到)。映射成「会话接力」让通知 body 对用户友好,不暴露内部名。
  //
  // archive-toctou-fix-20260515 plan: TOOL_DISPLAY_NAME 从 `Record<string, string>` narrow 到
  // `Record<CallerArchiveFailedToolName, string>` 强制完整覆盖 — 加新 emit 触发点(EventMap toolName
  // union 加值)忘加 TOOL_DISPLAY_NAME 条目时 tsc 编译期 fail(✅ feature),不再走 fallback `??
  // payload.toolName` 软兜底导致 IPC channel 内部名暴露给用户(R2 MED-1 修法的强化版)。
  type CallerArchiveFailedToolName = EventMap['caller-archive-failed'][0]['toolName'];
  const TOOL_DISPLAY_NAME: Record<CallerArchiveFailedToolName, string> = {
    archive_plan: 'plan 归档',
    hand_off_session: '会话接力',
    SessionHandOffSpawn: '会话接力',
  };
  eventBus.on('caller-archive-failed', (payload) => {
    try {
      const shortSid = payload.sessionId.slice(0, 8);
      const toolDisplay = TOOL_DISPLAY_NAME[payload.toolName];
      // body 文案区分 reasonKind 三档:
      // - archive-throw: row 存在但 archive 失败 → 「可重试归档」
      // - probe-throw: DB probe 异常 → 「可稍后重试」(区分 archive-throw 让用户知道是 DB 问题)
      // - row-missing: row 真不存在 → 「记录不可用」(仅告知)
      let body: string;
      if (payload.reasonKind === 'archive-throw') {
        body = `原会话未归档，可重试归档（${shortSid}…，工具：${toolDisplay}）`;
      } else if (payload.reasonKind === 'probe-throw') {
        body = `数据库异常无法探针原会话，可稍后重试归档（${shortSid}…，工具：${toolDisplay}）`;
      } else {
        body = `原会话记录不可用，归档未完成（${shortSid}…，工具：${toolDisplay}）`;
      }
      // R3 reviewer-codex MED-1 修法: 双通道独立 try/catch,避免 notifyUser 同步抛错导致
      // safeSend 不执行 → 双通道桥接退化为单通道 (macOS 通知故障时 renderer IPC 也丢)。
      // 通道 1 (macOS 通知) 与通道 2 (IPC 上抛) 各自独立 try/catch + console.error 兜底。
      try {
        notifyUser({
          title: 'Agent Deck 归档失败',
          body,
          level: 'info',
        });
      } catch (err) {
        console.error('[caller-archive-failed listener] notifyUser 异常 (吞掉,继续走 IPC 通道):', err);
      }
      try {
        safeSend(IpcEvent.CallerArchiveFailed, payload);
      } catch (err) {
        console.error('[caller-archive-failed listener] safeSend 异常:', err);
      }
    } catch (err) {
      // 兜底: body 构造或两通道 catch 自身异常,不能冒泡到 emit caller (会反向打崩 baton-cleanup /
      // archiveSourceSessionWithEmit 的 warn-only 不阻塞语义)。console.error 让排查不丢信息。
      console.error('[caller-archive-failed listener] internal throw (吞掉防撞穿 emit caller):', err);
    }
  });

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

  // 10.5 全局快捷键：Cmd/Ctrl+Alt+T 切换「窗口透明」开关
  // Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）：从 transparentWhenPinned
  // 重命名 + 解耦 alwaysOnTop。透明独立切换，不依赖 pin 状态 —— 用户可以在不 pin 时也开透
  // 明（视觉效果是 vibrancy null + CSS frosted）。floating.setWindowTransparent 是 idempotent。
  const transparentShortcut = 'CommandOrControl+Alt+T';
  const transparentRegistered = globalShortcut.register(transparentShortcut, () => {
    const w = floating.window;
    if (!w || w.isDestroyed()) return;
    const next = !(settingsStore.get('windowTransparent') ?? true);
    floating.setWindowTransparent(next);
    safeSend(IpcEvent.TransparentToggled, next);
  });
  if (!transparentRegistered) {
    console.warn(`[shortcut] failed to register ${transparentShortcut} (occupied by another app)`);
  }

  // 10.6 全局快捷键（CHANGELOG_124）：Cmd/Ctrl+Alt+= 一键到屏幕最大、Cmd/Ctrl+Alt+- 一键回默认 520×680
  // 两键各自 toggle：再按一次恢复上次「自定义」尺寸（共享 preferredSize 记忆字段，详 window.ts 内 JSDoc）。
  // 不发 IPC event：窗口尺寸 renderer 不需直接订阅（DOM 自身响应 resize），与 pin/transparent
  // 这种「persistent bool 视觉态」不同，无需双端 state 同步。
  //
  // 注：electron 接受多种 accelerator 写法，'=' 与 'Plus' 等价（同物理键，源码 keyboard_code_conversion.cc
  // 把两者都映射到 VKEY_OEM_PLUS）；macOS 上 Cmd+Alt+= 不撞系统快捷键，其他平台 Ctrl+Alt+= 同样空闲。
  // 若未来跨平台实测发现差异可改 'CommandOrControl+Alt+Plus'。
  // globalShortcut.register 返回 false 时仅 warn 不抛错（被其他 app 占用是合理边界）；
  // before-quit handler line ~487 `globalShortcut.unregisterAll()` 已统一收尾，新增两键无需单独处理。
  const maximizeShortcut = 'CommandOrControl+Alt+=';
  const maximizeRegistered = globalShortcut.register(maximizeShortcut, () => {
    floating.toggleMaximize();
  });
  if (!maximizeRegistered) {
    console.warn(`[shortcut] failed to register ${maximizeShortcut} (occupied by another app)`);
  }

  const defaultSizeShortcut = 'CommandOrControl+Alt+-';
  const defaultSizeRegistered = globalShortcut.register(defaultSizeShortcut, () => {
    floating.toggleDefault();
  });
  if (!defaultSizeRegistered) {
    console.warn(`[shortcut] failed to register ${defaultSizeShortcut} (occupied by another app)`);
  }

  // 11. 首启命令行
  setImmediate(() => {
    void handleCliArgv(process.argv);
  });
}

// REVIEW_35 MED-D-claude (HIGH→MED 降级 by codex 反驳)：line 53 锁失败已 app.quit() 立即退出。
// 后续所有 listener / whenReady().then(bootstrap) 全部隔离到 if (gotLock) { ... } 分支，
// 防止第二实例进 bootstrap 副作用（initDb / hookServer / IPC handler 重复注册等）。
// codex 反驳：whenReady 是 ready 后才 fulfilled 而非 microtask，原 finding「必现脏初始化」
// 证明过强，但工程问题真实 → 修法用 if(gotLock){...} 分支隔离（top-level return ESM 不合法）。
if (gotLock) {
  // REVIEW_35 MED-D-codex-4: 抓 bootstrap 完成 promise 让 second-instance handler 能等待
  const bootstrappedPromise = app.whenReady().then(() => bootstrap());
  bootstrappedPromise.catch((err) => {
    // REVIEW_35 R2 HIGH-D codex H2：bootstrap fatal reject 不能只 console.error，必须给用户
    // 可见反馈 + 退出（否则单实例锁仍占着，二次启动也只走 rejected promise warn，用户看到
    // 应用「假启动」状态：窗口未现 / 后续功能全挂）。dialog.showErrorBox 是同步阻塞，确保
    // 用户看到错误才退出。app.exit(1) 释放单实例锁。
    console.error('bootstrap failed', err);
    try {
      const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
      dialog.showErrorBox(
        'Agent Deck 启动失败',
        `应用初始化未完成，将退出。错误详情：\n\n${msg.slice(0, 2000)}`,
      );
    } catch (dialogErr) {
      console.error('showErrorBox failed during bootstrap fatal:', dialogErr);
    }
    // REVIEW_61 MED-B (codex) fix: 同 hook-server fatal 路径,fatal exit 前 best-effort closeDb
    // 保证 SQLite WAL checkpoint(initDb 已跑,bootstrap 中段抛错时 WAL 可能有写入)。
    try {
      closeDb();
    } catch (closeErr) {
      console.warn('[bootstrap fatal] closeDb error', closeErr);
    }
    app.exit(1);
  });

  app.on('second-instance', (_event, argv) => {
    const all = BrowserWindow.getAllWindows();
    if (all.length) {
      all[0].show();
      all[0].focus();
    }
    // REVIEW_35 MED-D-codex (codex MED-D4)：second-instance 在 cold-start 时可能在
    // bootstrap() 完成前触发 → handleCliArgv 调 adapterRegistry.get 拿不到 adapter → CLI new
    // 被当作 adapter 不可用处理。修法：把 bootstrap 完成 promise 抓回来，second-instance handler
    // 等 bootstrap 完成再投递 argv。
    void bootstrappedPromise.then(() => handleCliArgv(argv)).catch((err) =>
      console.warn('[second-instance] handleCliArgv failed', err),
    );
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
        teamScheduler?.stop();
        setTeamLifecycleScheduler(null);
        summarizer.stop();
        stopAllSounds();
        // R3.E5：universal-message-watcher shutdown
        universalMessageWatcher.stop();
        // REVIEW_35 MED-D-claude (D6): cleanup 整体 race-with-timeout 兜底，防 adapter
        // shutdown / hookServer stop / mcp http shutdown 任一卡死整个 quit 流程（codex CLI
        // 卡死等场景）。10s 超时降级 process.exit(1) 强退。
        // REVIEW_35 R2 MED-D claude (R2-3): closeDb 必须在 race 外**总是**跑保证 SQLite WAL
        // checkpoint（旧版包在 race 内 → 任一前序步骤卡 9.5s 后 closeDb 仅剩 0.5s budget → process.exit(1)
        // 在 closeDb 之前 → WAL 文件未 checkpoint 下次启动 replay log，极端 corruption 风险）。
        const cleanupSteps = (async (): Promise<void> => {
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
        })();
        const cleanupTimeout = new Promise<'__timeout__'>((resolve) =>
          setTimeout(() => resolve('__timeout__'), 10_000),
        );
        const result = await Promise.race([cleanupSteps.then(() => 'ok' as const), cleanupTimeout]);
        // closeDb 在 race 之外**总是**跑（sync 操作 + WAL checkpoint 关键）
        try {
          closeDb();
        } catch (err) {
          console.warn('[before-quit] closeDb error', err);
        }
        if (result === '__timeout__') {
          console.warn('[before-quit] cleanup timeout (10s), forcing exit (closeDb 已跑保证 WAL checkpoint)');
          process.exit(1);
        }
      } catch (err) {
        console.warn('[before-quit] cleanup error', err);
      } finally {
        app.exit(0);
      }
    })();
  });
}
