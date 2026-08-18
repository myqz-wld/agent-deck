/** Single-instance forwarding, window-close behavior, and bounded application shutdown hooks. */

import { app, BrowserWindow, globalShortcut } from 'electron';

import { closeDb } from '../store/db';
import { adapterRegistry } from '../adapters/registry';
import { setLifecycleScheduler } from '../session/lifecycle-scheduler';
import { setIssueLifecycleScheduler } from '../store/issue-lifecycle-scheduler';
import { setMessageLifecycleScheduler } from '../store/message-lifecycle-scheduler';
import { summarizer } from '../session/summarizer/desktop';
import { stopContinuationCheckpointRefreshService } from '../session/continuation-context/checkpoint-refresh-service';
import { stopAllSounds } from '../notify/sound';
import { universalMessageWatcher } from '../teams/universal-message-watcher';
import { handleCliArgv } from '../cli';
import { cleanupSessionHandOffPreparations } from '../ipc/session-hand-off';
import { getBrowserEngine } from '../browser-use/engine/registry';
import { shutdownBrowserRuntimeContexts } from '../browser-use/browser-runtime-context-host';
import { shutdownRemoteHostServiceIfCreated } from '../remote-host';

import type { BootstrapState } from './_deps';
import log from '@main/utils/logger';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';
import { beginAppShutdown } from './shutdown-state';

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
    void bootstrappedPromise.then(() => handleCliArgv(rawArgv)).catch((err) => {
      logger.warn('second-instance CLI handling failed', safeDiagnostic({
        event: 'app_lifecycle',
        phase: 'second-instance-cli',
        outcome: 'failed',
        error: safeErrorSummary(err),
      }));
    });
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
    beginAppShutdown();
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
      try {
        globalShortcut.unregisterAll();
        state.mainEventLoopMonitorStop?.();
        state.mainEventLoopMonitorStop = null;
        state.scheduler?.stop();
        setLifecycleScheduler(null);
        state.teamScheduler?.stop();
        // plan issue-tracker-mcp-20260529 §Step 3.7.2.5: stop IssueLifecycleScheduler 防 timer
        // 在 quit 期间继续碰 DB（与现有 LifecycleScheduler / TeamLifecycleScheduler 同款 stop 模式）
        state.issueScheduler?.stop();
        setIssueLifecycleScheduler(null);
        // plan message-retention-and-index-20260602 §D8: stop MessageLifecycleScheduler 防 6h tick /
        // 30s catch-up timer 在 quit 期间继续碰 DB（同 issue/session scheduler stop 模式）。
        state.messageScheduler?.stop();
        setMessageLifecycleScheduler(null);
        state.tokenUsageScheduler?.stop();
        const messageWatcherStop = universalMessageWatcher.stop()
          .then((result) => {
            if (!result.drained) {
              logger.warn(
                'message watcher drain did not complete during cleanup',
                lifecycleDiagnostic('message-watcher', 'degraded', undefined, {
                  activeDeliveries: result.activeDeliveries,
                  durableDelivering: result.durableDelivering,
                  timedOut: result.timedOut,
                }),
              );
            }
            return result.drained;
          })
          .catch((err) => {
            logger.warn(
              'message watcher stop failed during cleanup',
              lifecycleDiagnostic('message-watcher', 'failed', err),
            );
            return false;
          });
        const storageMaintenanceScheduler = state.storageMaintenanceScheduler;
        state.storageMaintenanceScheduler = null;
        // Begin the staged-worker drain immediately, but keep it inside the existing bounded quit
        // policy below. A lost worker response must not bypass the 10s adapter/MCP/hook timeout and
        // hang before closeDb/app.exit. Shutdown-only storage work still requires this promise to
        // settle successfully, so no third connection opens while a live slice may remain active.
        const storageMaintenanceStop = storageMaintenanceScheduler?.stop()
          .then(() => true)
          .catch((err) => {
            logger.warn(
              'storage worker stop failed during cleanup',
              lifecycleDiagnostic('storage-worker-stop', 'failed', err),
            );
            return false;
          }) ?? Promise.resolve(true);
        const checkpointRefreshStop = stopContinuationCheckpointRefreshService()
          .then(() => true)
          .catch((err) => {
            logger.warn(
              'checkpoint refresh stop failed during cleanup',
              lifecycleDiagnostic('checkpoint-refresh-stop', 'failed', err),
            );
            return false;
          });
        // Remote profiles own local SSH children even when the remote Core or Relay Worker is
        // offline. Fence new IPC immediately and begin retiring those children inside the same
        // application-wide shutdown bound. Keeping this in the central owner prevents app.exit()
        // from racing a separate before-quit hook.
        const remoteHostStop = shutdownRemoteHostServiceIfCreated()
          .then(() => true)
          .catch((err) => {
            logger.warn(
              'remote host transport shutdown failed during cleanup',
              lifecycleDiagnostic('remote-host-stop', 'failed', err),
            );
            return false;
          });
        const summaryStop = summarizer.stop()
          .then(() => true)
          .catch((err) => {
            logger.warn(
              'summary drain failed during cleanup',
              lifecycleDiagnostic('summary-stop', 'failed', err),
            );
            return false;
          });
        stopAllSounds();
        // REVIEW_35 MED-D-claude (D6): cleanup 整体 race-with-timeout 兜底,防 adapter
        // shutdown / hookServer stop / mcp http shutdown 任一卡死整个 quit 流程(codex CLI
        // 卡死等场景)。10s 超时降级 process.exit(1) 强退。
        const cleanupSteps = (async (): Promise<'ok' | 'degraded'> => {
          let allIngressStopped = true;
          if (!await checkpointRefreshStop) allIngressStopped = false;
          if (!await summaryStop) allIngressStopped = false;
          if (!await messageWatcherStop) allIngressStopped = false;
          if (!await remoteHostStop) allIngressStopped = false;
          // Background checkpoint folds and foreground hand-off preparations share the
          // connection-local continuation spool. Do not clear it until the refresh queue has
          // fully drained; otherwise shutdown can delete a frozen source underneath a running
          // fold. Foreground preparation cleanup remains best-effort inside the bounded quit
          // window, as before.
          cleanupSessionHandOffPreparations();
          const adapterShutdown = await adapterRegistry.shutdownAll();
          if (adapterShutdown.some((result) => !result.ok)) allIngressStopped = false;
          if (state.browserUseServerShutdown) {
            try {
              await state.browserUseServerShutdown();
            } catch (err) {
              allIngressStopped = false;
              logger.warn(
                'browser native-pipe shutdown failed during cleanup',
                lifecycleDiagnostic('browser-native-pipe-stop', 'failed', err),
              );
            }
            state.browserUseServerShutdown = null;
          }
          // Revoke and remove every session shim/context before closing the broker endpoint.
          shutdownBrowserRuntimeContexts();
          if (state.browserCliBrokerShutdown) {
            try {
              await state.browserCliBrokerShutdown();
            } catch (err) {
              allIngressStopped = false;
              logger.warn(
                'browser CLI broker shutdown failed during cleanup',
                lifecycleDiagnostic('browser-cli-broker-stop', 'failed', err),
              );
            }
            state.browserCliBrokerShutdown = null;
          }
          // Engine-owned windows outlive the native pipe: MCP browser tools open tabs without any
          // pipe connection, so the pipe shutdown above cannot close them.
          try {
            await getBrowserEngine().disposeAll();
          } catch (err) {
            allIngressStopped = false;
            logger.warn(
              'browser engine disposal failed during cleanup',
              lifecycleDiagnostic('browser-engine-dispose', 'failed', err),
            );
          }
          if (state.agentDeckMcpHttpShutdown) {
            try {
              await state.agentDeckMcpHttpShutdown();
            } catch (err) {
              allIngressStopped = false;
              logger.warn(
                'Agent Deck MCP HTTP shutdown failed during cleanup',
                lifecycleDiagnostic('agent-deck-mcp-stop', 'failed', err),
              );
            }
            state.agentDeckMcpHttpShutdown = null;
          }
          try {
            await state.hookServer?.stop();
          } catch (err) {
            allIngressStopped = false;
            logger.warn(
              'hook server shutdown failed during cleanup',
              lifecycleDiagnostic('hook-server-stop', 'failed', err),
            );
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
            logger.warn(
              'cleanup steps failed',
              lifecycleDiagnostic('cleanup-steps', 'failed', err),
            );
            return 'err' as const;
          }),
          cleanupTimeout,
        ]);
        timedOut = result === '__timeout__';
      } catch (err) {
        logger.warn(
          'before-quit cleanup failed',
          lifecycleDiagnostic('before-quit-cleanup', 'failed', err),
        );
      } finally {
        // closeDb 在 finally 中**无条件**跑（sync 操作 + WAL checkpoint 关键），所有可选存储
        // 收尾都已逐项 catch，因此 normal / cleanup-throw / reject / timeout 全部路径均会到达。
        try {
          closeDb();
        } catch (err) {
          logger.warn(
            'database close failed during cleanup',
            lifecycleDiagnostic('database-close', 'failed', err),
          );
        }
        if (timedOut) {
          logger.warn(
            'cleanup timed out; forcing exit after database checkpoint',
            lifecycleDiagnostic('cleanup-race', 'timeout', undefined, { timeoutMs: 10_000 }),
          );
          process.exit(1);
        }
        app.exit(0);
      }
    })();
  });
}

function lifecycleDiagnostic(
  phase: string,
  outcome: string,
  error?: unknown,
  details: Record<string, string | number | boolean> = {},
): ReturnType<typeof safeDiagnostic> {
  return safeDiagnostic({
    event: 'app_shutdown',
    phase,
    outcome,
    ...details,
    ...(error === undefined ? {} : { error: safeErrorSummary(error) }),
  });
}
