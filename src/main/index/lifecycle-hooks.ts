// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.8 拆分:bootstrap god-function 之外的 module-level lifecycle
// hooks 段(原 L486-594 if (gotLock) { ... } 内 3 app.on + bootstrappedPromise
// catch handler)。
//
// hooks:
// - app.on('second-instance'):聚焦窗口 + 等 bootstrap 完成后转发 argv 到 handleCliArgv
// - app.on('window-all-closed'):非 darwin 直接 quit
// - app.on('before-quit'):cleaningUp idempotent guard + globalShortcut.unregisterAll +
//   event-loop monitor/scheduler/teamScheduler/summarizer/stopAllSounds/universalMessageWatcher 同步停 +
//   adapterRegistry.shutdownAll / agentDeckMcpHttpShutdown / hookServer.stop 走 10s
//   race-with-timeout 兜底 + 完整 drain 后 await 独立 storage worker + closeDb 在 race 外
//   **总是**跑保 SQLite WAL checkpoint
//   (REVIEW_35 R2 MED-D claude R2-3 修法)。
// ────────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, globalShortcut } from 'electron';

import { closeDb, getDb } from '../store/db';
import { hasPendingStorageShutdownTasks } from '../store/storage-maintenance/shutdown-tasks';
import { runStorageShutdownMaintenance } from '../store/storage-maintenance/shutdown-runner';
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
import { cleanupSessionHandOffPreparations } from '../ipc/session-hand-off';

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
      // reject;② closeDb 放入 finally，先完成可失败的存储收尾并逐项兜底，再无条件 checkpoint，
      // 最后决定 process.exit(1) vs app.exit(0)。
      let timedOut = false;
      let ingressDrained = false;
      try {
        globalShortcut.unregisterAll();
        state.mainEventLoopMonitorStop?.();
        state.mainEventLoopMonitorStop = null;
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
        const storageMaintenanceScheduler = state.storageMaintenanceScheduler;
        state.storageMaintenanceScheduler = null;
        // Begin the staged-worker drain immediately, but keep it inside the existing bounded quit
        // policy below. A lost worker response must not bypass the 10s adapter/MCP/hook timeout and
        // hang before closeDb/app.exit. Shutdown-only storage work still requires this promise to
        // settle successfully, so no third connection opens while a live slice may remain active.
        const storageMaintenanceStop = storageMaintenanceScheduler?.stop()
          .then(() => true)
          .catch((err) => {
            logger.warn('[storage-maintenance] staged worker stop failed during cleanup', err);
            return false;
          }) ?? Promise.resolve(true);
        summarizer.stop();
        stopAllSounds();
        // R3.E5:universal-message-watcher shutdown
        universalMessageWatcher.stop();
        cleanupSessionHandOffPreparations();
        // REVIEW_35 MED-D-claude (D6): cleanup 整体 race-with-timeout 兜底,防 adapter
        // shutdown / hookServer stop / mcp http shutdown 任一卡死整个 quit 流程(codex CLI
        // 卡死等场景)。10s 超时降级 process.exit(1) 强退。
        const cleanupSteps = (async (): Promise<'ok' | 'degraded'> => {
          let allIngressStopped = true;
          const adapterShutdown = await adapterRegistry.shutdownAll();
          if (adapterShutdown.some((result) => !result.ok)) allIngressStopped = false;
          if (state.agentDeckMcpHttpShutdown) {
            try {
              await state.agentDeckMcpHttpShutdown();
            } catch (err) {
              allIngressStopped = false;
              logger.warn('[agent-deck-mcp] HTTP shutdown failed during cleanup', err);
            }
            state.agentDeckMcpHttpShutdown = null;
          }
          try {
            await state.hookServer?.stop();
          } catch (err) {
            allIngressStopped = false;
            logger.warn('[hook-server] shutdown failed during cleanup', err);
          }
          if (!await storageMaintenanceStop) allIngressStopped = false;
          return allIngressStopped ? 'ok' : 'degraded';
        })();
        const cleanupTimeout = new Promise<'__timeout__'>((resolve) =>
          setTimeout(() => resolve('__timeout__'), 10_000),
        );
        // REVIEW_104 MED-B: cleanupSteps.catch 兜成 'err' 哨兵 → Promise.race 永不 reject,
        // 保证控制流必到下方,closeDb(finally)必跑。reject 不再静默绕过 closeDb + timeout 保护。
        const result = await Promise.race([
          cleanupSteps.catch((err) => {
            logger.warn('[before-quit] cleanup steps error', err);
            return 'err' as const;
          }),
          cleanupTimeout,
        ]);
        timedOut = result === '__timeout__';
        ingressDrained = result === 'ok';
      } catch (err) {
        logger.warn('[before-quit] cleanup error', err);
      } finally {
        // Cold copy gates measured 0.84s snapshot-index creation and 5.8-6.0s legacy FTS DROP.
        // Run both on an isolated SQLite worker only after every ingress owner drained. The main
        // connection stays open but idle, then is closed unconditionally below for its checkpoint.
        if (ingressDrained) {
          try {
            const db = getDb();
            if (hasPendingStorageShutdownTasks(db)) {
              const results = await runStorageShutdownMaintenance(db.name);
              logStorageShutdownResults(results);
            }
          } catch (err) {
            logger.warn('[storage-maintenance] shutdown worker failed; tasks remain retryable', err);
          }
        }
        // closeDb 在 finally 中**无条件**跑（sync 操作 + WAL checkpoint 关键），所有可选存储
        // 收尾都已逐项 catch，因此 normal / cleanup-throw / reject / timeout 全部路径均会到达。
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

function logStorageShutdownResults(
  results: Awaited<ReturnType<typeof runStorageShutdownMaintenance>>,
): void {
  if (results.snapshotIndexes.ok) {
    if (results.snapshotIndexes.result.prepared) {
      logger.info('[storage-maintenance] snapshot GC indexes prepared on shutdown worker', {
        durationMs: Math.round(results.snapshotIndexes.result.durationMs),
      });
    }
  } else {
    logger.warn(
      `[storage-maintenance] snapshot GC index preparation deferred: ` +
        results.snapshotIndexes.error,
    );
  }

  if (results.eventSearchRetirement.ok) {
    if (results.eventSearchRetirement.result.retired) {
      logger.info('[storage-maintenance] legacy event search index retired on shutdown worker', {
        durationMs: Math.round(results.eventSearchRetirement.result.durationMs),
        freedPages: results.eventSearchRetirement.result.freedPages,
      });
    }
  } else {
    logger.warn(
      `[storage-maintenance] legacy event search retirement deferred: ` +
        results.eventSearchRetirement.error,
    );
  }
}
