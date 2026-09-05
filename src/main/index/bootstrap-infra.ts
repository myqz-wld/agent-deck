// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.8 拆分:bootstrap god-function 的 infrastructure init 段
// (原 bootstrap Phase 0-8.6,L88-280)。
//
// 顺序敏感(sequence 是 hookServer / mcp / adapter / scheduler / IPC 互相依赖):
// Phase 0   app id + applyClaudeSettingsEnv + browser-window-created listener
// Phase 1   initDb
// Phase 2   settings.getAll
// Phase 2.5 main event-loop delay monitor
// Phase 3   HookServer + RouteRegistry 创建
// Phase 4   adapter register
// Phase 5   adapter.initAll + setSessionCloseFn + setSessionRenameHookFn hook 注入
// Phase 5.5 mcp HTTP transport mount (PRE_LISTEN — 必须在 hookServer.start 之前)
// Phase 6   hookServer.start() + EADDRINUSE fail-loud (return null 让 caller skip wiring)
// Phase 7   scheduler / teamScheduler / summarizer / syncSkills
// Phase 7.05 universal-message-watcher.start()
// Phase 7.1 开机自启
// Phase 8   bootstrapIpc
// Phase 8.5 loadBundledAssets
// Phase 8.6 file reapers
//
// 返回 AppSettings | null: 非 null = ok 继续 wiring(settings 快照透传 initWiring,REVIEW_104 LOW-E);
//   null = fatalExit (EADDRINUSE 已 app.exit(1))
// ────────────────────────────────────────────────────────────────────────────

import { app, dialog, powerMonitor } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { HookServer } from '../hook-server/server';
import { RouteRegistry } from '../hook-server/route-registry';
import {
  AGENT_DECK_DATABASE_FILENAME,
  initDb,
  closeDb,
  isDbClosed,
} from '../store/db';
import { settingsStore } from '../store/settings-store';
import { installDesktopEventRepositoryDiagnostics } from '../store/event-repo-diagnostics-host';
import { installDesktopAgentDeckTeamRepositoryDiagnostics } from '../store/agent-deck-team-repo/diagnostics-host';
import { installDesktopFileChangeReadDiagnostics } from '../store/file-change-read-diagnostics-host';
import { installDesktopMessageDeliveryStateDiagnostics } from '../store/message-delivery-state-diagnostics-host';
import { installDesktopSessionRepositoryDiagnostics } from '../store/session-repo/diagnostics-host';
import { installDesktopHandOffDiagnostics } from '../session/hand-off/diagnostics-host';
import { applyClaudeSettingsEnv } from '../adapters/claude-code/settings-env';
import { initializeProviderRuntimeCore } from '../adapters/provider-runtime-core';
import { createProviderAdapterContext } from '../adapters/provider-adapter-context-core';
import { desktopProviderRuntimeCompositionHost } from '../adapters/provider-runtime-host';
import { sessionManager } from '../session/manager';
import { LifecycleScheduler, setLifecycleScheduler } from '../session/lifecycle-scheduler';
import { TeamLifecycleScheduler } from '../teams/team-lifecycle-scheduler';
import {
  IssueLifecycleScheduler,
  setIssueLifecycleScheduler,
} from '../store/issue-lifecycle-scheduler';
import {
  MessageLifecycleScheduler,
  setMessageLifecycleScheduler,
} from '../store/message-lifecycle-scheduler';
import { TokenUsageLifecycleScheduler } from '../store/token-usage-lifecycle-scheduler';
import { createDesktopStorageMaintenanceScheduler } from '../store/storage-maintenance';
import { summarizer } from '../session/summarizer/desktop';
import { startDesktopContinuationCheckpointRefreshService } from '../session/continuation-context/checkpoint-refresh-desktop';
import { routeEventToNotification } from '../notify/event-router';
import { bootstrapIpc } from '../ipc';
import { prefetchProviderUsageSnapshots } from '../ipc/provider-usage';
import { loadBundledAssets } from '../bundled-assets';
import { reapStaleUploads } from '../store/image-uploads';
import { universalMessageWatcher } from '../teams/universal-message-watcher';
import { AGENT_DECK_MCP_TOKEN_ENV } from '../codex-config/agent-deck-mcp-injector';
import { unionUserShellPath } from '../utils/user-shell-path';
import { startMainEventLoopMonitor } from '../utils/main-event-loop-monitor';
import { startBrowserCliBroker } from '../browser-use/browser-cli-broker';
import { initializeBrowserRuntimeContextHost } from '../browser-use/browser-runtime-context-host';
import { initializeBrowserViewHost } from '../browser-use/view-host';
import { getBrowserShowController } from '../browser-use/browser-show-runtime';
import { reapBrowserScreenshotsAtStartup } from '../browser-use/screenshot-store';
// NOTE(REVIEW_<X>):以下 codex-config 模块**必须**走 static import,不要改回 dynamic import。
// 同一模块在多处 dynamic import 会让 vite SSR/rollup 把模块代码 inline
// 进主 index.js,独立 chunk 文件只剩 require 空壳没有 export → 运行时 dynamic import 拿到空对象 →
// 「X is not a function」(dev 模式 ESM 直 import 测不出,只在打包后炸)。模块顶部纯 import + export
// function,无副作用,static import 等价。
import { syncSkills } from '../codex-config/skills-installer';
import { syncLoginItemSetting } from '../login-item';
import type { AgentEvent } from '@shared/types';
import type { AppSettings } from '@shared/types/settings/app-settings';
import { worktreeTransitionCoordinator } from '../session/worktree-transition/coordinator';
import { reconcileWorktreeTransitionsAtStartup } from '../session/worktree-transition/recovery';
import { startWorktreeTransitionResumeRecovery } from '../session/worktree-transition/resume-recovery';

import type { BootstrapState } from './_deps';
import log, { setFileLevel } from '@main/utils/logger';
import { emitProcessStartupRecord } from '@main/utils/process-startup';
import { readSchemaUserVersion } from '@main/utils/run-context';

const logger = log.scope('bootstrap-infra');
const databaseLogger = log.scope('store-db');

/**
 * bootstrap god-function Phase 0-8.6 infrastructure init 段。
 *
 * @returns AppSettings(init 全成功)= 把 Phase 2 读到的 settings 快照交给 caller 传给 initWiring,
 *   避免 wiring 段再独立 settingsStore.getAll() 一次(REVIEW_104 LOW-E:同一 .then 内无 await 间隙,
 *   两次读快照等价,改为单次读 + 显式传递,既省一次全量读又让「共享同一快照」不变量显式);
 *   null = fatalExit (EADDRINUSE 已 app.exit(1) + closeDb,caller 应直接 return defensive)
 */
export async function initInfra(state: BootstrapState): Promise<AppSettings | null> {
  electronApp.setAppUserModelId('com.agentdeck.app');

  // 0. 把 ~/.claude/settings.json 的 env 注入到主进程
  applyClaudeSettingsEnv();

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // 0.5 mutate process.env.PATH = union(user shell PATH, process.env.PATH)
  // 让所有后续 spawn (SDK 子进程 + 主进程 git 等) 自动 inherit 完整 PATH
  // (修 macOS .app launchd 启动 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin 问题)。
  // 详 plan ref/plans/sdk-spawn-shell-path-20260529.md §设计决策 + §不变量 9。
  //
  // 守门 `newPath !== ''` 防 PATH 完全失效:极端 dev 情景下 process.env.PATH undefined +
  // captureUserShellPath 失败时 unionUserShellPath 返 ''(`originalPath ?? ''` 分支),
  // mutate '' 比 undefined 严格更差(`Object.entries(process.env)` skip undefined keys 让
  // child 走 Node 默认查找;'' 是 string 进 entries 让 child 拿空 PATH 全部 lookup fail)。
  // production .app 不触发(launchd 总设 minimal `/usr/bin:/bin:/usr/sbin:/sbin`)。
  // Step 3.6 reviewer-claude Round 1 LOW-1 hardening。
  const newPath = unionUserShellPath(process.env.PATH);
  if (newPath !== process.env.PATH && newPath !== '') {
    process.env.PATH = newPath;
  }

  // 1. 数据库
  installDesktopEventRepositoryDiagnostics();
  installDesktopAgentDeckTeamRepositoryDiagnostics();
  installDesktopFileChangeReadDiagnostics();
  installDesktopMessageDeliveryStateDiagnostics();
  installDesktopSessionRepositoryDiagnostics();
  installDesktopHandOffDiagnostics();
  const database = initDb({
    databasePath: join(app.getPath('userData'), AGENT_DECK_DATABASE_FILENAME),
    diagnostics: databaseLogger,
  });

  // 2. 设置
  const settings = settingsStore.getAll();
  // Emit while the logger's startup default is still "info"; reversing these two calls would make
  // a configured warn/error level suppress the startup identity record from the file transport.
  // The record itself carries the configured level, which is applied immediately afterward.
  emitProcessStartupRecord({
    schemaUserVersion: readSchemaUserVersion(
      () => database.pragma('user_version', { simple: true }),
    ),
    configuredFileLogLevel: settings.logLevel,
  });
  // REVIEW_68 batch-2 [MED reviewer-codex]: logger.ts 模块加载把 file transport 固定 'info'，持久化
  // settings.logLevel 仅在后续 SettingsSet patch 含 logLevel 时经 applyLogLevel 生效 → 重启后运行时
  // 回退 'info' 与 UI 显示的持久化值不一致。启动读 settings 后补一次 setFileLevel 应用持久化级别。
  setFileLevel(settings.logLevel);
  state.mainEventLoopMonitorStop = startMainEventLoopMonitor({ powerMonitor });

  // 3. HookServer + RouteRegistry
  state.hookServer = new HookServer(
    settings.hookServerPort,
    settings.hookServerToken ?? '',
    settings.mcpServerToken ?? '',
  );
  state.routeRegistry = new RouteRegistry(state.hookServer);

  // 4-5. Provider registration, partial-init diagnostics, and session lifecycle hooks share one
  // host-neutral composition. This Electron bootstrap supplies only its concrete event/path ports.
  await initializeProviderRuntimeCore(desktopProviderRuntimeCompositionHost, createProviderAdapterContext({
    hookServer: state.hookServer,
    routeRegistry: state.routeRegistry,
    emit: (event: AgentEvent) => {
      // shutdown race guard (issue shutdown-race-ingest-db-guard):closeDb() 跑过后 adapter
      // in-flight 尾包仍会经本 sink 飞回。ingest 入口自身已查 isDbClosed() 短路(主修法),此处
      // 在 sink 顶端再 drop 一次有两个收益:① sink 另一消费者 routeEventToNotification 对
      // finished/waiting-for-user 事件会 sessionManager.get() → getDb() throw(虽被 event-router
      // 自身 try/catch 兜住不 crash,但产生 "notification dispatch failed" 噪音 log + 无谓工作);
      // ② 显式表达「DB 关闭后退出期事件整体丢弃」意图,两消费者对称受护(避免只挡 ingest 留
      // routeEventToNotification 半拉子,与 REVIEW_104 只补一条 listener 的不对称裂口同型)。
      if (isDbClosed()) return;
      if (!worktreeTransitionCoordinator.observe(event)) return;
      sessionManager.ingest(event);
      routeEventToNotification(event);
    },
    paths: {
      appUserData: app.getPath('userData'),
      userHome: homedir(),
      userClaudeSettings: join(homedir(), '.claude', 'settings.json'),
    },
  }));
  // 5.2 Reconcile persisted cwd transitions after adapters exist but before MCP routes or
  // ordinary user ingress can accept work. Any failure retains its lease fail-closed.
  const worktreeRecovery = await reconcileWorktreeTransitionsAtStartup();
  if (
    worktreeRecovery.recovered > 0 ||
    worktreeRecovery.skippedClosed > 0 ||
    worktreeRecovery.failed > 0
  ) {
    logger.info(
      '[worktree-transition] startup reconciliation completed',
      worktreeRecovery,
    );
  }
  startWorktreeTransitionResumeRecovery();

  // 5.5. R2 / B'4 + R1.A5 + R1.D7:Agent Deck MCP server 自动启停(PRE_LISTEN 阶段)
  // **必须在 hookServer.start() 之前注册 routes**,否则 fastify 5.x 在 listen 后调
  // app.route() 会抛 FST_ERR_INSTANCE_ALREADY_LISTENING(lib/route.js:208
  // throwIfAlreadyStarted)→ MCP HTTP /mcp 完全不挂 → codex / 外部 MCP client 连不上。
  // 详见 REVIEW_27 / CHANGELOG_70(cdb01ae 引入时位置错了,本次前移收口)。
  // - 把 mcpServerToken 设进 process.env 当全局 fallback token(plan codex-handoff-team-alignment-20260518
  //   D1 §(c) 共存策略):per-session codex teammate 通过 envOverride 注入自己的 session token
  //   走 mcpSessionTokenMap 反查 sid(sdk-bridge ensureCodex per-session 路径);外部 codex CLI /
  //   非应用 spawn 路径继承全局 process.env.AGENT_DECK_MCP_TOKEN 走全局 fallback token →
  //   HookServer.checkMcpAuth 走 fallbackToGlobal=true 路径让 handler 视为 external caller
  //   (EXTERNAL_CALLER_ALLOWED 表只允许 list/get,spawn/send/shutdown 全 deny)。
  //   一次性设,运行时不再 mutate(删 setAgentDeckMcpTokenEnv setter,P2 Step 2.6)。
  // - 双开关同 ON 时挂 HTTP /mcp 路由(StreamableHTTPServerTransport),让 codex /
  //   外部 MCP client 能连
  if (settings.mcpServerToken && settings.mcpServerToken.length > 0) {
    process.env[AGENT_DECK_MCP_TOKEN_ENV] = settings.mcpServerToken;
  } else {
    delete process.env[AGENT_DECK_MCP_TOKEN_ENV];
  }
  if (settings.enableAgentDeckMcp && settings.mcpHttpEnabled) {
    try {
      const { registerAgentDeckMcpHttpRoutes } = await import(
        '../agent-deck-mcp/transport-http'
      );
      const handle = await registerAgentDeckMcpHttpRoutes(state.routeRegistry);
      state.agentDeckMcpHttpShutdown = handle.shutdown;
      logger.info('[agent-deck-mcp] HTTP transport mounted at /mcp');
    } catch (err) {
      logger.error('[agent-deck-mcp] failed to mount HTTP transport', err);
    }
  }

  // 6. 启动 HookServer(POST_LISTEN 分水岭:此行之后任何 routeRegistry /
  // registerRoute 调用都会被 HookServer.registerRoute 的 invariant 拒)
  try {
    await state.hookServer.start();
    logger.info(`[hook-server] listening on 127.0.0.1:${state.hookServer.listeningPort}`);
  } catch (err) {
    // REVIEW_35 follow-up rH R2-M4: HookServer 是 hooks/MCP 通道的根基,启动失败不能让应用
    // 半启动(旧版只 console.error 后继续 → scheduler/IPC/window 正常起,hooks 通道全挂但
    // UI 无明确错误)。EADDRINUSE 典型场景:上次崩溃 / 另一实例残留 / 端口被占用。
    // fail-loud:dialog.showErrorBox 同步反馈用户 + app.exit(1) 释放单实例锁让用户能改端口重启。
    logger.error('[hook-server] failed to start', err);
    const reason = err instanceof Error ? err.message : String(err);
    const isAddrInUse = /EADDRINUSE/i.test(reason);
    try {
      dialog.showErrorBox(
        'Agent Deck 启动失败 — Hook 服务无法绑定端口',
        isAddrInUse
          ? `端口 ${state.hookServer.listeningPort} 被占用(EADDRINUSE)。\n\n可能原因:\n` +
            `• 另一个 Agent Deck 实例残留(请检查任务管理器 / Activity Monitor 杀掉旧进程)\n` +
            `• 该端口被其他应用占用\n\n` +
            `修法:在 ~/.claude/agent-deck/settings.json 改 hookServerPort 后重启。\n\n` +
            `详细错误:\n${reason.slice(0, 500)}`
          : `Hook 服务启动失败:${reason.slice(0, 1000)}`,
      );
    } catch (dialogErr) {
      logger.error('showErrorBox failed during hook-server EADDRINUSE:', dialogErr);
    }
    // REVIEW_61 MED-B (codex) fix: app.exit(1) 不发 before-quit/will-quit (Electron 文档),
    // ./lifecycle-hooks.ts before-quit handler 不会跑 → closeDb() 不会执行 → SQLite WAL 不 checkpoint。
    // initDb 已在 Phase 1 跑过,WAL 可能有未 checkpoint 的写入(applyClaudeSettingsEnv /
    // settings 读 / adapter init 都可能触发 SELECT/UPDATE)。fatal exit 前同步 best-effort
    // 跑 closeDb,失败仅 warn 不阻塞 exit(本来就是 fatal 路径,WAL 丢一点比 hang 住强)。
    try {
      closeDb();
    } catch (err) {
      logger.warn('[hook-server fatal] closeDb error', err);
    }
    app.exit(1);
    return null;
  }

  // 7. 启动生命周期调度器与总结器
  state.scheduler = new LifecycleScheduler({
    activeWindowMs: settings.activeWindowMs,
    closeAfterMs: settings.closeAfterMs,
    historyRetentionDays: settings.historyRetentionDays,
  });
  state.scheduler.start();
  setLifecycleScheduler(state.scheduler);
  // plan team-cohesion-fix-20260513 Phase F D7:team 生命周期 scheduler。5min 周期 +
  // 30min grace。lead 经过 D6 路径自动 archive 是主路径;本 scheduler 是兜底(程序
  // ungraceful 退出 / hook 绕过 sessionManager 的场景定期清理幽灵 team)。
  state.teamScheduler = new TeamLifecycleScheduler();
  state.teamScheduler.start();
  // plan issue-tracker-mcp-20260529 §Step 3.7.2 / §D13 / §D20: Issue Tracker GC scheduler。
  // 默认 6h tick — retention 单位是 day,GC 漂移几小时无害。aretentionDays=0 跳过该路径 GC。
  state.issueScheduler = new IssueLifecycleScheduler({
    resolvedRetentionDays: settings.issueResolvedRetentionDays,
    softDeletedRetentionDays: settings.issueSoftDeletedRetentionDays,
  });
  state.issueScheduler.start();
  setIssueLifecycleScheduler(state.issueScheduler);
  // plan message-retention-and-index-20260602 §D8: agent_deck_messages retention GC scheduler。
  // 默认 6h tick + 30s catch-up（同 IssueLifecycleScheduler）。messageRetentionDays=0 跳过 GC。
  state.messageScheduler = new MessageLifecycleScheduler({
    messageRetentionDays: settings.messageRetentionDays,
  });
  state.messageScheduler.start();
  setMessageLifecycleScheduler(state.messageScheduler);
  // token_usage is the history source for daily token stats, so keep a fixed 365d retention.
  // This intentionally has no settings panel control; it is only a background storage guard.
  state.tokenUsageScheduler = new TokenUsageLifecycleScheduler();
  state.tokenUsageScheduler.start();
  // v041 only creates empty targets and durable cursors. A persistent SQLite worker takes over live
  // PASSIVE checkpoints after its ready handshake, then starts adaptive backfill after a 15s grace.
  // Codec work, maintenance writes, and their commit/checkpoint tails never execute on Electron main.
  state.storageMaintenanceScheduler = createDesktopStorageMaintenanceScheduler();
  state.storageMaintenanceScheduler.start();
  summarizer.start();
  startDesktopContinuationCheckpointRefreshService(settings);

  // 7.0 app ready 后准备 app-owned skills extraRoot。
  // syncSkills 走 static import(顶部 import 段已说明原因),
  // 这里同步直接调;失败只 warn 不抛(不阻断 main 启动),与 settings.ts 同步路径同模式。
  try {
    syncSkills();
  } catch (err) {
    logger.warn('[bootstrap] syncSkills 失败', err);
  }

  // 7.05 R3.E5:universal-message-watcher 启动(cross-adapter team message 投递)
  universalMessageWatcher.start();

  // 7.1 开机自启
  syncLoginItemSetting(settings.startOnLogin, { dev: is.dev });

  // 8. IPC
  bootstrapIpc();

  // 8.1 数据 tab provider quota 预热：fire-and-forget 填充 main 端 TTL cache。
  // DataPanel 打开时仍走同一个 IPC handler；若预热未完成则复用 in-flight promise。
  void prefetchProviderUsageSnapshots();

  // Native Browser views need a continuously painted, non-focusable host even while the IAB tab is
  // not selected. Creating it here keeps it out of provider/session construction paths.
  try {
    const browserViewHost = initializeBrowserViewHost({
      onShowRequested: (surface, target) => getBrowserShowController().request(surface, target),
    });
    state.browserViewHostDispose = () => {
      getBrowserShowController().reset();
      browserViewHost.dispose();
    };
  } catch (err) {
    logger.warn('[browser-view] parking host unavailable', err);
  }

  // 8.2 Unified Browser CLI broker. Runtime shims carry only an opaque Browser lease; the broker
  // resolves it to the stable application session before entering the shared semantic executor.
  let browserCliBroker: Awaited<ReturnType<typeof startBrowserCliBroker>> | null = null;
  try {
    browserCliBroker = await startBrowserCliBroker();
    initializeBrowserRuntimeContextHost(browserCliBroker.endpoint);
    state.browserCliBrokerShutdown = browserCliBroker.shutdown;
    logger.info('[browser-cli] authenticated session broker is ready');
  } catch (err) {
    await browserCliBroker?.shutdown().catch(() => undefined);
    logger.warn('[browser-cli] broker unavailable; Browser CLI contexts stay disabled', err);
  }

  // 8.5 预热 agent-deck plugin 内置 agents/skills frontmatter 缓存
  try {
    loadBundledAssets();
  } catch (err) {
    logger.warn('[main] loadBundledAssets failed:', err);
  }

  // 8.6 file reapers: attachments retain 14 days; generated browser screenshots retain 7 days.
  void reapStaleUploads();
  void reapBrowserScreenshotsAtStartup();

  // REVIEW_104 LOW-E: 把 Phase 2 读到的 settings 快照返给 caller 传给 initWiring,省 wiring 段重复读。
  return settings;
}
