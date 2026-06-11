// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.8 拆分:bootstrap god-function 之外的 module-level lifecycle
// hooks 段(原 L486-594 if (gotLock) { ... } 内 3 app.on + bootstrappedPromise
// catch handler)。
//
// hooks:
// - app.on('second-instance'):聚焦窗口 + 等 bootstrap 完成后转发 argv 到 handleCliArgv
// - app.on('window-all-closed'):非 darwin 直接 quit
// - app.on('before-quit'):cleaningUp idempotent guard + globalShortcut.unregisterAll +
//   scheduler/teamScheduler/summarizer/stopAllSounds/universalMessageWatcher 同步停 +
//   adapterRegistry.shutdownAll / agentDeckMcpHttpShutdown / hookServer.stop 走 10s
//   race-with-timeout 兜底 + closeDb 在 race 外**总是**跑保 SQLite WAL checkpoint
//   (REVIEW_35 R2 MED-D claude R2-3 修法)。
// ────────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, globalShortcut } from 'electron';

import { closeDb } from '../store/db';
import { adapterRegistry } from '../adapters/registry';
import { setLifecycleScheduler } from '../session/lifecycle-scheduler';
import { setTeamLifecycleScheduler } from '../teams/team-lifecycle-scheduler';
import { setIssueLifecycleScheduler } from '../store/issue-lifecycle-scheduler';
import { setMessageLifecycleScheduler } from '../store/message-lifecycle-scheduler';
import { setTokenUsageLifecycleScheduler } from '../store/token-usage-lifecycle-scheduler';
import { summarizer } from '../session/summarizer';
import { stopAllSounds } from '../notify/sound';
import { universalMessageWatcher } from '../teams/universal-message-watcher';
import { handleCliArgv } from '../cli';

import type { BootstrapState } from './_deps';
import log from '@main/utils/logger';

const logger = log.scope('lifecycle-hooks');

/**
 * 注册 module-level app.on lifecycle hooks。仅当 single-instance lock 持有时由
 * facade 调用。second-instance handler 内 .then(handleCliArgv) 需要 caller 传
 * bootstrappedPromise(facade 创建包含 initInfra + initWiring 的复合 promise)。
 */
export function registerLifecycleHooks(
  state: BootstrapState,
  bootstrappedPromise: Promise<void>,
): void {
  app.on('second-instance', (_event, commandLine, _workingDir, additionalData) => {
    const all = BrowserWindow.getAllWindows();
    if (all.length) {
      all[0].show();
      all[0].focus();
    }
    // Chromium 会把 commandLine 里的所有 --flag 前置、值后置，破坏 parseCliInvocation 的
    // key-value 解析。additionalData.argv 可用时优先使用；macOS wrapper new 路径另有
    // payload token，handleCliArgv 会在 parse 前解码。
    const rawArgv =
      additionalData != null &&
      typeof additionalData === 'object' &&
      Array.isArray((additionalData as { argv?: unknown }).argv)
        ? ((additionalData as { argv: string[] }).argv)
        : commandLine;
    // REVIEW_35 MED-D-codex (codex MED-D4):second-instance 在 cold-start 时可能在
    // bootstrap() 完成前触发 → handleCliArgv 调 adapterRegistry.get 拿不到 adapter → CLI new
    // 被当作 adapter 不可用处理。修法:把 bootstrap 完成 promise 抓回来,second-instance handler
    // 等 bootstrap 完成再投递 argv。
    void bootstrappedPromise.then(() => handleCliArgv(rawArgv)).catch((err) =>
      logger.warn('[second-instance] handleCliArgv failed', err),
    );
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  let cleaningUp = false;
  app.on('before-quit', (event) => {
    // REVIEW_104 MED-A (reviewer-codex): 重入分支也必须 preventDefault()。第一次 before-quit
    // 已 preventDefault + 起 10s 异步 cleanup;若用户/系统在 cleanup 期间再次触发 quit(连按
    // Cmd+Q / autoUpdater.quitAndInstall),第二个 before-quit 进来若只 `return` 不 preventDefault,
    // Electron 走默认终止路径(electron.d.ts: before-quit 不 preventDefault → terminating the app),
    // in-flight cleanup(adapterRegistry.shutdownAll / hookServer.stop / closeDb)被硬截断 → WAL
    // 不 checkpoint。修法:重入也 preventDefault,挡住默认退出;最终退出统一走下方 app.exit(0)
    // (app.exit 不触发 before-quit,不会卡在本 guard,electron.d.ts 实测确认)。
    if (cleaningUp) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    cleaningUp = true;
    void (async () => {
      // REVIEW_104 MED-B (reviewer-claude): closeDb 必须在所有路径**无条件**跑(WAL checkpoint
      // 不变量)。旧版把 closeDb 放在 `await Promise.race(...)` resolve 之后 + 外层 try 内 → 若
      // cleanupSteps reject(未来有人往里加无 try/catch 的 await)→ race reject → 直接跳外层
      // catch → closeDb 被跳过,同时绕过 10s timeout 保护(MED-A/B 共同侵蚀同一 WAL 不变量的
      // 两条路径:重入 vs reject)。修法:① cleanupSteps 用 .catch 兜成 'err' 哨兵让 race 永不
      // reject;② closeDb 提到 finally 块开头,无论 cleanup error / timeout / 正常都先跑,再决定
      // process.exit(1) vs app.exit(0)。
      let timedOut = false;
      try {
        globalShortcut.unregisterAll();
        state.scheduler?.stop();
        setLifecycleScheduler(null);
        state.teamScheduler?.stop();
        setTeamLifecycleScheduler(null);
        // plan issue-tracker-mcp-20260529 §Step 3.7.2.5: stop IssueLifecycleScheduler 防 timer
        // 在 quit 期间继续碰 DB（与现有 LifecycleScheduler / TeamLifecycleScheduler 同款 stop 模式）
        state.issueScheduler?.stop();
        setIssueLifecycleScheduler(null);
        // plan message-retention-and-index-20260602 §D8: stop MessageLifecycleScheduler 防 6h tick /
        // 30s catch-up timer 在 quit 期间继续碰 DB（同 issue/session scheduler stop 模式）。
        state.messageScheduler?.stop();
        setMessageLifecycleScheduler(null);
        state.tokenUsageScheduler?.stop();
        setTokenUsageLifecycleScheduler(null);
        summarizer.stop();
        stopAllSounds();
        // R3.E5:universal-message-watcher shutdown
        universalMessageWatcher.stop();
        // REVIEW_35 MED-D-claude (D6): cleanup 整体 race-with-timeout 兜底,防 adapter
        // shutdown / hookServer stop / mcp http shutdown 任一卡死整个 quit 流程(codex CLI
        // 卡死等场景)。10s 超时降级 process.exit(1) 强退。
        const cleanupSteps = (async (): Promise<void> => {
          await adapterRegistry.shutdownAll();
          if (state.agentDeckMcpHttpShutdown) {
            try {
              await state.agentDeckMcpHttpShutdown();
            } catch (err) {
              logger.warn('[agent-deck-mcp] HTTP shutdown failed during cleanup', err);
            }
            state.agentDeckMcpHttpShutdown = null;
          }
          try {
            await state.hookServer?.stop();
          } catch {
            // ignore: 已经在退出
          }
        })();
        const cleanupTimeout = new Promise<'__timeout__'>((resolve) =>
          setTimeout(() => resolve('__timeout__'), 10_000),
        );
        // REVIEW_104 MED-B: cleanupSteps.catch 兜成 'err' 哨兵 → Promise.race 永不 reject,
        // 保证控制流必到下方,closeDb(finally)必跑。reject 不再静默绕过 closeDb + timeout 保护。
        const result = await Promise.race([
          cleanupSteps.then(() => 'ok' as const).catch((err) => {
            logger.warn('[before-quit] cleanup steps error', err);
            return 'err' as const;
          }),
          cleanupTimeout,
        ]);
        timedOut = result === '__timeout__';
      } catch (err) {
        logger.warn('[before-quit] cleanup error', err);
      } finally {
        // closeDb 在 finally 块开头**无条件**跑(sync 操作 + WAL checkpoint 关键),在 app.exit /
        // process.exit 之前,覆盖 normal / cleanup-throw / reject / timeout 全部路径。
        try {
          closeDb();
        } catch (err) {
          logger.warn('[before-quit] closeDb error', err);
        }
        if (timedOut) {
          logger.warn('[before-quit] cleanup timeout (10s), forcing exit (closeDb 已跑保证 WAL checkpoint)');
          process.exit(1);
        }
        app.exit(0);
      }
    })();
  });
}
