// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.8 拆分(facade):main 进程入口 — single-instance lock + bootstrap
// 启动 promise + lifecycle hooks 注册。bootstrap god-function 392 LOC 已拆到
// ./index/bootstrap-infra.ts (Phase 0-8.6) + ./index/bootstrap-wiring.ts (Phase 9-11);
// module-level app.on lifecycle hooks 拆到 ./index/lifecycle-hooks.ts。共享 state
// (5 module-level let 单例聚合)+ helpers 在 ./index/_deps.ts 单源。
// ────────────────────────────────────────────────────────────────────────────

// Plan runtime-logging-electron-log-20260529 §D7 + §Step 3.0.4: 第一行 import logger.ts,
// 让 errorHandler.startCatching() 立即生效 + app.setName('Agent Deck') 让 dev/prod log
// path 一致 + Object.assign(console, log.functions) 接管 console。logger.ts §不变量 8
// 仅依赖 electron + electron-log/main + node:* (不依赖任何业务模块) 安全可第一行。
import './utils/logger';

import { app, dialog } from 'electron';
import { closeDb } from './store/db';

import { createInitialBootstrapState } from './index/_deps';
import { initInfra } from './index/bootstrap-infra';
import { initWiring } from './index/bootstrap-wiring';
import { registerLifecycleHooks } from './index/lifecycle-hooks';

// 防止 packaged GUI 模式下 stdout/stderr 管道被对端关闭时,console.log/error 抛出
// EPIPE 升级为 uncaughtException 把 main 进程整个挂掉。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const gotLock = app.requestSingleInstanceLock();
// 锁失败立即 quit;后续 listener 注册全部隔离到 if (gotLock) { ... } 分支,
// 防止第二实例进 bootstrap 副作用(initDb / hookServer / IPC handler 重复注册)。
// REVIEW_35 MED-D-claude (HIGH→MED 降级 by codex 反驳)。
if (!gotLock) {
  app.quit();
}

// REVIEW_35 MED-D-claude (HIGH→MED 降级 by codex 反驳):line 22 锁失败已 app.quit() 立即退出。
// 后续所有 listener / whenReady().then(bootstrap) 全部隔离到 if (gotLock) { ... } 分支,
// 防止第二实例进 bootstrap 副作用(initDb / hookServer / IPC handler 重复注册等)。
// codex 反驳:whenReady 是 ready 后才 fulfilled 而非 microtask,原 finding「必现脏初始化」
// 证明过强,但工程问题真实 → 修法用 if(gotLock){...} 分支隔离(top-level return ESM 不合法)。
if (gotLock) {
  // 5 module-level let 单例聚合到单一 BootstrapState mutable object,sub-module 通过 state
  // 参数 read/write 同一引用(详 ./index/_deps.ts BootstrapState 注释)。
  const state = createInitialBootstrapState();

  // REVIEW_35 MED-D-codex-4: 抓 bootstrap 完成 promise 让 second-instance handler 能等待
  const bootstrappedPromise = app.whenReady().then(async () => {
    const ok = await initInfra(state);
    // initInfra return false 仅在 EADDRINUSE fail-loud 路径(已 dialog.showErrorBox + closeDb +
    // app.exit(1)),defensive 早返回防 race(exit 是 sync but immediate)。
    if (!ok) return;
    initWiring();
  });
  bootstrappedPromise.catch((err) => {
    // REVIEW_35 R2 HIGH-D codex H2:bootstrap fatal reject 不能只 console.error,必须给用户
    // 可见反馈 + 退出(否则单实例锁仍占着,二次启动也只走 rejected promise warn,用户看到
    // 应用「假启动」状态:窗口未现 / 后续功能全挂)。dialog.showErrorBox 是同步阻塞,确保
    // 用户看到错误才退出。app.exit(1) 释放单实例锁。
    console.error('bootstrap failed', err);
    try {
      const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
      dialog.showErrorBox(
        'Agent Deck 启动失败',
        `应用初始化未完成,将退出。错误详情:\n\n${msg.slice(0, 2000)}`,
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

  registerLifecycleHooks(state, bootstrappedPromise);
}
