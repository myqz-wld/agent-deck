# Spike (b) — preload IPC bridge 在 vite + asar 下行为（**延后至 Step 3.0**）

## 状态：DEFERRED

本 spike 验证 `log.initialize({ preload: true })` 在 electron-vite + asar 打包下能否让 renderer 端 `import log from 'electron-log/renderer'` 正常 IPC 转发到 main，落进同一份 `app.getPath('logs')/main-YYYY-MM-DD.log`。

**延后理由**：必须在真实 Electron 运行时（main 进程 spawn renderer 后）才能实测，不能纯 Node 跑。spike (a)(c) 已用 `electron-log/node.js` 入口在 Node 沙箱跑通，但 (b) 涉及 preload script 注入 + IPC bridge 必须 Electron。

## 实施 Step 3.0 计划

Plan Step 3.0（实施第一步）安装 electron-log + 写最小 main 端 logger.ts + renderer 端 logger.ts + 跑 `pnpm dev` 实测：

### 验证清单（Round 1 fix M8 加 B6-B9）

- [ ] **B1**: `pnpm dev` 启动后 main 进程 console.log 走 logger，落进 `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log`
- [ ] **B2**: renderer 端 React 组件内 `console.log(...)` 经 IPC bridge 落进同一份 main-YYYY-MM-DD.log
- [ ] **B3**: renderer 端的 log 在 file 中带 `(renderer)` scope 或类似标记，与 main 端可区分
- [ ] **B4**: `pnpm dist` 打包出 .app 后双击启动，无终端附着，仍写 `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log`（关键：本 plan 的根本目标，验证生产场景日志真正落盘）
- [ ] **B5**: `electron.vite.config.ts` 的 preload entry 不需要额外 import electron-log preload（electron-log 5.x `log.initialize` 自动注入，但 vite asar 打包下行为需验证）
- [ ] **B6** (Round 1 fix M8): `webPreferences.contextIsolation: true` 启用下 electron-log preload 注入是否正常 — 项目 `src/main/window/lifecycle.ts:60` 已开 contextIsolation，ipcRenderer 不能直接在 renderer 用必须经 contextBridge.exposeInMainWorld，electron-log v5 自动 preload 注入需验证兼容
- [ ] **B7** (Round 1 fix M8): asar 打包后 `join(__dirname, '../preload/index.js')` (`lifecycle.ts:58`) 路径变化下，electron-log monkey-patched preload script 是否正确解析（asar 文件系统抽象层）
- [ ] **B8** (Round 1 fix M8): `webPreferences.sandbox: false` (`lifecycle.ts:59`) 与 electron-log preload 兼容性（electron-log 默认设计针对 sandbox: true）
- [ ] **B9** (Round 1 fix M8 / LOW-Codex): 多 BrowserWindow recreate 场景（Cmd+W 关窗 → macOS Dock activate 重建 → 重建后 BrowserWindow renderer log 仍落盘） — `src/main/window/lifecycle.ts:28-62` 支持 recreate 路径，验证 monkey-patched BrowserWindow constructor 是 process-wide 还是 per-instance

### 验证方法

main 进程 logger.ts:
```typescript
import log from 'electron-log/main';
log.initialize({ preload: true }); // 自动加载 preload script 注入 renderer
```

renderer main.tsx 顶部：
```typescript
import log from 'electron-log/renderer';
if (import.meta.env.MODE !== 'test') {
  Object.assign(console, log.functions);
}
```

跑 `pnpm dev` → DevTools 内 `console.log('hello from renderer')` → tail `~/Library/Logs/Agent Deck/main-*.log` 看是否落盘。

## fallback design（spike B 失败兜底 — Round 1 fix M5+INFO-3 修订）

如果 `log.initialize({ preload: true })` 在 vite + asar 下不能正常注入 preload script（可能性 < 10%），fallback 走 **typed IPC channel + miscApi facade**（**禁用已删除的 raw `window.electronIpc.invoke(channel)` 通道**，详 `src/preload/index.ts:33-36` 注释 + `REVIEW_35 MED-B4` 删除原因）：

1. **`src/shared/ipc-channels.ts`** 加 channel 常量：
   ```typescript
   export const IpcInvoke = {
     // ... existing channels
     LogWrite: 'log:write',
   } as const;
   ```
2. **main 端 `src/main/ipc/logs.ts`** 注册 handler：
   ```typescript
   ipcMain.on(IpcInvoke.LogWrite, (_e, { level, scope, args }) => {
     const logger = scope ? log.scope(scope) : log;
     logger[level](...args);
   });
   ```
3. **`src/preload/api/misc.ts`** 加 typed method（走现有 miscApi facade）：
   ```typescript
   export const miscApi = {
     // ... existing methods
     writeLog: (level, scope, args) => ipcRenderer.send(IpcInvoke.LogWrite, { level, scope, args }),
   };
   ```
4. **renderer logger.ts** wrapper：
   ```typescript
   function makeLogger(scope?: string) {
     return {
       info: (...args) => window.api.writeLog('info', scope, args),
       warn: (...args) => window.api.writeLog('warn', scope, args),
       error: (...args) => window.api.writeLog('error', scope, args),
       debug: (...args) => window.api.writeLog('debug', scope, args),
       silly: (...args) => window.api.writeLog('silly', scope, args),
     };
   }
   ```
5. **类型 declaration**：`AgentDeckApi` 自动从 miscApi spread 推导，renderer `window.api.writeLog` 强类型 zero-change

**成本**（Round 1 fix INFO-3 修订估计）：**约 80-120 行代码**（原写 40-60 行严重低估），含：
- main handler 注册 ≈ 10-15 行
- preload miscApi method + types ≈ 15-20 行
- renderer logger wrapper（5 个 level × scope 化） ≈ 30-50 行
- shared/ipc-channels.ts 常量 + types ≈ 10-15 行
- lifecycle / ready 守门 / error catch ≈ 10-20 行

**Code review 成本**：typed facade 路径与项目现有 IPC 风格一致（详 `src/preload/api/misc.ts:51-54`），但仍是 fallback 兜底；优先走 spike B 成功路径。

## 新增 spike (d) — preload console.error 落盘（Round 1 fix H2 降级修订）

reviewer-claude HIGH-1 + reviewer-codex 反驳综合：preload `src/preload/index.ts:38` 的 `console.error` 是 `contextBridge.exposeInMainWorld('api', api)` 失败的 init signal，生产 .app 无终端 → silent failure，与 plan §不变量 1 冲突。修法不能简单 `import 'electron-log/preload'`（实测 electron-log preload.js 只暴露 sendToMain helper 不自动接管 console — Claude 原修法机制错）。

### spike (d) 验证四方案（Round 2 fix R2-10 / LOW-Claude 8 加方案 4）

Step 3.0.7 在 Electron 运行时（pnpm dev / pnpm dist）跑：故意制造 `contextBridge.exposeInMainWorld('api', <bad-api-throw>)` 失败 → 看 `~/Library/Logs/Agent Deck/main-*.log` 是否落 error。

**方案 1: 显式调 electron-log preload helper**
- 改 `src/preload/index.ts:38` `console.error(e)` → `electronLog.sendToMain({ level: 'error', data: [e], scope: 'preload-fatal' })`（手动构造 message + 调 sendToMain）
- electron-log preload.js source 实证：`sendToMain(message) { ipcRenderer.send('__ELECTRON_LOG__', message); }` — **不依赖 contextBridge.exposeInMainWorld('api', ...) 成功**
- 优点：复用 electron-log IPC channel；缺点：依赖未文档化的内部 API（electron-log 升级可能 break）

**方案 2: 自建 typed `IpcInvoke.PreloadFatalError` channel**
- 加 channel 常量 + main 端 `ipcMain.on('preload:fatal-error', (_, err) => log.scope('preload').error(err))` handler + preload 直接 `ipcRenderer.send('preload:fatal-error', { message, stack })`
- 优点：完全 typed + 与项目 IPC facade 风格一致；缺点：多写 ~20 行 channel + handler

**方案 3: main 端 `webContents.on('console-message', ...)` 跨进程拦截**
- 在 BrowserWindow create 后注册 `win.webContents.on('console-message', (e, level, message, line, sourceId) => log.scope(sourceId.includes('preload') ? 'preload' : 'renderer')[mapLevel(level)](message))`
- 优点：覆盖面最广，preload + renderer 所有 console.* 都拦（含 console.log / console.warn / debug）；缺点：与 console capture 接管语义重叠（renderer 端 D5 `Object.assign(console, log.functions)` 已经接管 → console-message 还会 fire？需测试避免双倍落盘）

**方案 4: main 端 `webContents.on('preload-error', ...)` 兜底 preload 加载失败**（Round 2 fix R2-10 / LOW-Claude 8 新增）
- 在 BrowserWindow create 后注册 `win.webContents.on('preload-error', (event, preloadPath, error) => log.scope('preload-fatal').error(error, preloadPath))`
- 兜底场景：**preload script 本身加载失败**（语法错 / asar 路径错 / require 失败）— 此时方案 1/2/3 **全失效**（preload 还没跑到 `try { contextBridge.exposeInMainWorld } catch` 这一步）
- 与方案 3 互补不冲突：preload-error 拦 preload 加载失败 / console-message 拦 preload 加载成功后内部 throw
- 优点：覆盖 preload 加载本身崩溃的最早期 error；缺点：仅 preload 加载阶段，runtime 阶段无效（runtime 走方案 1/2/3）

### 选定原则（Round 2 fix R2-4 / MED-Codex 2 修正 truth table）

按 pass/fail 优先级顺序判定（**精确判定，无歧义**）：

1. **方案 3 通过 AND 无双倍落盘** → 选方案 3（覆盖面最广 + future-proof）+ 同时启用方案 4 兜底 preload 加载失败
2. **方案 3 不通过 OR 双倍落盘** → 退至方案 2（typed + 项目风格一致），如方案 2 通过则选方案 2 + 同时启用方案 4
3. **方案 2 不通过** → 退至方案 1 backup（依赖未文档化 API electronLog.sendToMain），如方案 1 通过则选方案 1 + 同时启用方案 4
4. **方案 1/2/3 全失败** → 仅启用方案 4 + 接受 runtime 阶段 preload error silent failure 的限制 + 在 plan §不变量 1 加注脚说明

### 量化「通过」判定标准（Round 2 fix R2-4 + LOW-Claude 7）

- **方案 X「通过」**：故意触发 `contextBridge.exposeInMainWorld('api', api)` 失败 → tail `~/Library/Logs/Agent Deck/main-*.log` → 看到包含「error」level + contextBridge 失败 stack 完整（含文件名 / 行号）
- **方案 3「双倍落盘」**：renderer 端跑 `console.log('test')` 1 次 → log file `grep 'test' main-*.log | wc -l` 必须 = 1；**>1 次即双倍落盘**（说明 console capture 接管 + console-message 同时 fire 重复落盘）
- **方案 1 API 升级 break 风险**：lock electron-log major version；electron-log major upgrade 时 `electronLog.sendToMain` 不存在 / 签名变 → 方案 1 立即失效需切方案 2/3
- **方案 4「通过」**：改坏 preload `import('inexistent-module')` 让 preload 加载失败 → 看 main log 是否有 `preload-error` 行（包含 preloadPath + error stack）

### 修订 §设计决策 D10

Step 3.0.7 spike (d) 选定方案后回填 plan §设计决策 D10「preload 1 处 console.error 单独处理」段落，明确选 1/2/3 哪个方案 + 是否启用方案 4 + 落地代码片段；同步更新 §不变量 4 数字（如方案 3 选定则 preload 1 处不需单独 migrate，§不变量 4 数字保持 354 + 1）。**Round 2 fix R2-8 注**: preload 改动单独 commit 走 plan **Step 3.2.6**（不混入 Step 3.3 main migrate 批次）。

## 关于 IPC bridge 工作机制（来自 electron-log doc + GitHub README）

引用 electron-log v5 README (https://github.com/megahertz/electron-log)：

> **`log.initialize()`** — main 进程调用此函数后，electron-log 自动注入一段 preload script 到所有 BrowserWindow（通过 monkey-patching `BrowserWindow` constructor），让 renderer 端的 `import log from 'electron-log/renderer'` 拿到的 logger 通过 ipcRenderer 转发到 main 进程，main 端的 file transport 落盘。
>
> v5 默认 `preload: true`（v4 需要显式启用）。

**理论上 vite + asar 应该不影响 IPC bridge 工作**，因为：
- preload script 是 main 进程通过 BrowserWindow constructor inject，不依赖 vite 打包
- ipcRenderer 是 Electron 内置 API，不被 vite tree-shake
- asar 不影响 IPC（asar 只是 file system 抽象）

但仍需 Step 3.0 实测 verify，因为：
- electron-vite 可能改 BrowserWindow 启动方式（如自定义 webPreferences）
- contextIsolation 启用时 ipcRenderer 不能直接在 renderer 用，必须经 contextBridge.exposeInMainWorld（项目实测时关注）
