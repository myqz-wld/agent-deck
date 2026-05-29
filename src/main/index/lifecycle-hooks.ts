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
  app.on('second-instance', (_event, argv) => {
    const all = BrowserWindow.getAllWindows();
    if (all.length) {
      all[0].show();
      all[0].focus();
    }
    // REVIEW_35 MED-D-codex (codex MED-D4):second-instance 在 cold-start 时可能在
    // bootstrap() 完成前触发 → handleCliArgv 调 adapterRegistry.get 拿不到 adapter → CLI new
    // 被当作 adapter 不可用处理。修法:把 bootstrap 完成 promise 抓回来,second-instance handler
    // 等 bootstrap 完成再投递 argv。
    void bootstrappedPromise.then(() => handleCliArgv(argv)).catch((err) =>
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
    if (cleaningUp) return;
    event.preventDefault();
    cleaningUp = true;
    void (async () => {
      try {
        globalShortcut.unregisterAll();
        state.scheduler?.stop();
        setLifecycleScheduler(null);
        state.teamScheduler?.stop();
        setTeamLifecycleScheduler(null);
        summarizer.stop();
        stopAllSounds();
        // R3.E5:universal-message-watcher shutdown
        universalMessageWatcher.stop();
        // REVIEW_35 MED-D-claude (D6): cleanup 整体 race-with-timeout 兜底,防 adapter
        // shutdown / hookServer stop / mcp http shutdown 任一卡死整个 quit 流程(codex CLI
        // 卡死等场景)。10s 超时降级 process.exit(1) 强退。
        // REVIEW_35 R2 MED-D claude (R2-3): closeDb 必须在 race 外**总是**跑保证 SQLite WAL
        // checkpoint(旧版包在 race 内 → 任一前序步骤卡 9.5s 后 closeDb 仅剩 0.5s budget → process.exit(1)
        // 在 closeDb 之前 → WAL 文件未 checkpoint 下次启动 replay log,极端 corruption 风险)。
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
        const result = await Promise.race([cleanupSteps.then(() => 'ok' as const), cleanupTimeout]);
        // closeDb 在 race 之外**总是**跑(sync 操作 + WAL checkpoint 关键)
        try {
          closeDb();
        } catch (err) {
          logger.warn('[before-quit] closeDb error', err);
        }
        if (result === '__timeout__') {
          logger.warn('[before-quit] cleanup timeout (10s), forcing exit (closeDb 已跑保证 WAL checkpoint)');
          process.exit(1);
        }
      } catch (err) {
        logger.warn('[before-quit] cleanup error', err);
      } finally {
        app.exit(0);
      }
    })();
  });
}
