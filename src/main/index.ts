// The main entry owns single-instance gating and bootstrap orchestration. Infrastructure runs
// before wiring, while lifecycle hooks share the same state and bootstrap completion promise.

// Keep the logger as the first import so fatal handlers, app naming, transports, and console
// interception initialize before business-module side effects.
import log from './utils/logger';

import { app, dialog } from 'electron';
import { closeDb } from './store/db';

import { createInitialBootstrapState } from './index/_deps';
import { initInfra } from './index/bootstrap-infra';
import { initWiring } from './index/bootstrap-wiring';
import { registerLifecycleHooks } from './index/lifecycle-hooks';
import { safeDiagnostic } from './utils/safe-diagnostic';
import { getProcessRunId } from './utils/run-context';
import {
  mainBootstrapErrorDiagnostic,
  type MainBootstrapStage,
} from './index/bootstrap-diagnostics';

type BootstrapFailurePhase = 'bootstrap' | 'error-dialog' | 'database-close';

function createMainLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('main-index');
  } catch {
    return null;
  }
}

const logger = createMainLogger();

function logBootstrapFailure(
  phase: BootstrapFailurePhase,
  stage: MainBootstrapStage,
  error: unknown,
): void {
  try {
    logger?.error(
      'main bootstrap failed',
      safeDiagnostic({
        event: 'main-bootstrap',
        runId: getProcessRunId(),
        phase,
        stage,
        outcome: 'failed',
        error: mainBootstrapErrorDiagnostic(error),
      }),
    );
  } catch {
    // Terminal diagnostics must not alter shutdown behavior.
  }
}

// 防止 packaged GUI 模式下 stdout/stderr 管道被对端关闭时,console.log/error 抛出
// EPIPE 升级为 uncaughtException 把 main 进程整个挂掉。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// Forward argv best-effort to the first instance; platform delivery may omit additional data.
const gotLock = app.requestSingleInstanceLock({ argv: process.argv });
// A lock miss quits without registering listeners or starting bootstrap side effects.
if (!gotLock) {
  app.quit();
}

if (gotLock) {
  // All bootstrap components share one mutable state object.
  const state = createInitialBootstrapState();
  let bootstrapStage: MainBootstrapStage = 'electron-ready';

  // Keep the completion promise so second-instance handling can await initialization.
  const bootstrappedPromise = app.whenReady().then(async () => {
    bootstrapStage = 'infrastructure';
    const settings = await initInfra(state);
    // A null snapshot means infrastructure already handled its fatal shutdown. Otherwise wiring
    // consumes the same settings snapshot to avoid a second read.
    if (!settings) return;
    bootstrapStage = 'wiring';
    initWiring(settings);
    bootstrapStage = 'complete';
  });
  bootstrappedPromise.catch((err) => {
    // Fatal bootstrap actions remain ordered: user-visible dialog, best-effort database close,
    // then exit. Diagnostic and secondary failures cannot interrupt that sequence.
    logBootstrapFailure('bootstrap', bootstrapStage, err);
    try {
      const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
      dialog.showErrorBox(
        'Agent Deck 启动失败',
        `应用初始化未完成,将退出。错误详情:\n\n${msg.slice(0, 2000)}`,
      );
    } catch (dialogError) {
      logBootstrapFailure('error-dialog', bootstrapStage, dialogError);
    }
    try {
      closeDb();
    } catch (databaseError) {
      logBootstrapFailure('database-close', bootstrapStage, databaseError);
    }
    app.exit(1);
  });

  registerLifecycleHooks(state, bootstrappedPromise);
}
