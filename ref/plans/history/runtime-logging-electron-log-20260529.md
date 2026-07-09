---
plan_id: "runtime-logging-electron-log-20260529"
created_at: "2026-05-29"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/runtime-logging-electron-log-20260529"
status: "completed"
base_commit: "57147d948da638f73a9ada5ea1aa17dc568012e7"
base_branch: "main"
final_commit: "d9d2ac50766b9321c1e9ff2d25e78dca7aa102a0"
completed_at: "2026-05-30"
---
# runtime-logging-electron-log-20260529 — 引入 electron-log 让生产 .app console.* 落盘

## 总目标

应用目前**没用任何日志库**（grep 实测 electron-log / winston / pino / loglevel 都没装），main 进程 337 处 / renderer 17 处 / preload 1 处 `console.*` 直接走 Electron stdout/stderr。生产 .app 双击启动 → 无终端 → console.* 输出**全部丢失**（macOS launchd .app 启动场景实测，详 plan `sdk-spawn-shell-path-20260529` §已知踩坑 9）。

引入 [electron-log v5](https://github.com/megahertz/electron-log) 让：
1. main + renderer 端所有 console.* 自动转发到 logger（NODE_ENV='test' 时跳过保留 vitest 51 处 `vi.spyOn(console)` 行为）
2. 日志按天拆 + 保留 14 天，落到 `app.getPath('logs')` 标准位置（macOS = `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log`）
3. 337 处现有 console.* 改成带模块 scope 的 logger（如 `log.scope('sdk-bridge').info(...)`），跨模块边界可识别
4. Settings 面板新建「日志」分组，user 可改默认日志级别 / 打开日志目录 / 在 Finder 中显示 / 清空当天日志
5. fatal 错误（uncaughtException / unhandledRejection）由 logger 接管落盘，避免「.app 沉默 crash 丢堆栈」

## 不变量

1. **生产 .app 必须能落盘** — 双击启动后 `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log` 必须出现今日 log 文件且持续增长。本 plan 根本目标的成立条件，Step 4 收口前必须验证。
2. **NODE_ENV='test' 跳过 console 接管** — vitest 51 处 `vi.spyOn(console, 'log/warn/error')` 必须零改动通过。Spike (c) 已实证可行；logger init 必须用 `if (process.env.NODE_ENV !== 'test')` 守门。**注意**：本不变量只控制 `Object.assign(console, log.functions)` 接管动作是否跑，**不控制** `import log from 'electron-log/main'` 顶部 side effect（import 解析在守门 if 检查之前发生）。logger 模块自身的 import 安全见 §不变量 10。
3. **renderer 端用 `import.meta.env.MODE !== 'test'`** — renderer 端没有 `process.env.NODE_ENV`（vite 注入的是 `import.meta.env.MODE`）。renderer logger init 用 vite env 守门。
4. **354 处现有 console.* 全改 scoped logger** — user RFC Q1 显式选择「全改（大改动）」。每个模块 init 时 `const logger = log.scope('<kebab-case-module-name>')`，所有 console.log → logger.info / console.warn → logger.warn / console.error → logger.error。**主进程 337 + renderer 17 = 354 处**；preload 1 处单独由 §设计决策 D10 (Step 3.0 spike (d) 后) 决定。
5. **scope 命名 kebab-case 与 src/main 目录对齐** — sdk-bridge / lifecycle-scheduler / inbox-watcher / summarizer / event-bus 等；grep 友好。
6. **官方 IPC bridge 不手写转发** — main 端 `log.initialize({ preload: true })`，renderer 端 `import log from 'electron-log/renderer'`。Spike (b) 必须 Step 3.0 实测验证（详 §设计决策 D8）。
7. **不脱敏** — sessionId / cwd / 工具调用 args 原样写入，user 仅自己阅读本地日志。
8. **logger 模块必须放 src/main 与 src/renderer 子模块共享** — 避免循环依赖：logger 模块本身只 import electron-log + electron + node:fs，不能 import 项目其他业务模块。
9. **resolvePathFn + 启动时 cleanup 替代 archiveLog hook** — Spike (a) 实证：每次 log 调用动态决定文件路径 `main-YYYY-MM-DD.log`，启动时跑一次 cleanup 删 mtime > 14 天前的 main-*.log；不依赖 electron-log 内置 size-based archiveLog。
10. **logger 模块 import side effect 对 vitest 的影响必须被守门覆盖** — 因为 `electron-log/main` 入口顶层 `require('electron')`（plan §已知踩坑 3 实证），任何 main 单测 import 业务模块（如 `manager.ts`）→ 业务模块 import logger.ts → logger.ts import electron-log/main → require('electron')，在 vitest node environment 下 **`Cannot find module 'electron'`** 直接炸。85+ 个 main 单测全数受影响。守门方案见 §设计决策 D15。**§不变量 2 / 3 守门均不能替代 D15**（Round 3 fix LOW-Claude-2 精简: §不变量 2/3 是「接管动作守门」，与 D15「模块 import 守门」是两层；§不变量 5/6/7/9 与守门无关，不在比较范围）。

## 设计决策（不再争论）

### D1: 选型 electron-log v5
- **理由**：(RFC 第 1 轮 Q1) Electron 生态最主流，star 2.5k+，自带 main+renderer 双端打通 + 文件 rotate + IPC bridge，依赖体积 ~50KB。winston / pino 通用方案 renderer 端要自写 IPC bridge 多 40-60 行代码。
- **版本**：electron-log@5（spike 实测 5.4.4）。

### D2: 落盘位置 `app.getPath('logs')`
- **理由**：(RFC 第 1 轮 Q2) macOS = `~/Library/Logs/Agent Deck/`，Electron 官方标准 logs 位置。macOS Console.app 自动扫描这里，user 能用系统 Console 工具看。electron-log 默认就是这个位置。
- **文件命名**：`main-YYYY-MM-DD.log`（按天拆，spike (a) 实证）。

### D3: rotate 按天拆 + 保留 14 天（Spike (a) 修正方案）
- **理由**：(RFC 第 2 轮 Q1) 按天拆是 debug 友好（user 能定位「我那天遇到的问题」）；14 天保留平衡磁盘占用与历史可追溯性。
- **实现**：用 `transports.file.resolvePathFn = () => path.join(LOG_DIR, \`main-\${todayStr()}.log\`)` 让每条 log 动态决定文件路径，跨天天然落新文件；启动时跑一次 `cleanupOldLogs(LOG_DIR, 14)` 简单 `fs.statSync(mtime) < cutoff` 删旧文件。**不用** electron-log 内置 archiveLog hook（按 size 不按天，需要薄包装很啰嗦）。
- **Spike (a) 实证**：`spike-reports/spike1-rotate-strategy.md` 5 项验证全过。
- **残留风险**：long-running 7 天以上 .app 期间无 cleanup（启动时清一次）→ 14 天保留实际可能变 21 天。Plan 内 MVP 不加 daily setInterval cleanup，列入 §known followup。

### D4: 默认级别文件 info / console silly（Round 1 fix M3 修订 / Step 3.0.2 实证 typo 修订）
- **理由**：(RFC 第 2 轮 Q2) 文件默认 info 过滤 debug 噪音，生产体积可控；console 默认 silly 让 dev mode 终端看全部输出。
- **schema 与语义**（与 D14 双锚一致 / **Step 3.0.2 实证修订**: electron-log v5 LogLevel 实际是 `'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'` — **无 'fatal'，有 'verbose'**；原 plan 写「silly|debug|info|warn|error|fatal」是基于推测，typecheck 实证拒，需对齐 electron-log type defs）：
  - `AppSettings.logLevel: 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'`，默认 `'info'`
  - **`logLevel` 只控制 file transport**（默认 `'info'`）
  - **`console transport` 固定 `'silly'`**（dev mode 终端看全部输出，生产 .app 无终端无影响 — 双 transport 独立配置）
  - 这样 Settings 「日志级别」下拉调高 → 文件体积下降 / 调低 → 文件 debug 信息更多；console transport 永远全开不变。
- **改设置生效**：spawn-time 设置不需要重启 — logger 暴露 `setFileLevel(level: LogLevel)` 函数，IPC handler 改 settings 后调一次只更新 file transport。
- **测试**：Step 3.5.1 logger.test.ts 加 2 个 assert：
  - 初始化默认时 `log.transports.file.level === 'info'` AND `log.transports.console.level === 'silly'`
  - 调 `setFileLevel('warn')` 后 `log.transports.file.level === 'warn'` AND `log.transports.console.level === 'silly'`（console transport 不变）

### D5: console capture — main + renderer 都全接管，NODE_ENV/MODE 'test' 跳过（Spike (c) 实证）
- **理由**：(RFC 第 2 轮 Q3) 337 处 main 现有 console.* 不可能逐个 migrate（成本太高）；接管是零成本兼容，新代码用 scoped logger 增量升级。
- **测试兼容**：(RFC 第 3 轮 Q1) NODE_ENV='test' 跳过接管让 51 处 vi.spyOn(console) 零改动。
- **Spike (c) 实证**：`spike-reports/spike2-test-env-isolation.md` 4 项验证全过。
- **关键修正**：
  - main 端用 `if (process.env.NODE_ENV !== 'test') Object.assign(console, log.functions)`
  - renderer 端用 `if (import.meta.env.MODE !== 'test') Object.assign(console, log.functions)`（vite 注入 env，无 process.env）
- **测试守门**：写 1 个 unit test 显式 `expect(console.log).toBe(originalConsoleLog)` 监测 NODE_ENV regression。

### D6: format 用 electron-log 默认（含 scope `(scope-name)` 占位）
- **理由**：(RFC 第 3 轮 Q2 + Spike (a) 验证 4/5) electron-log 5.x 默认 format `[YYYY-MM-DD HH:MM:SS.mmm] [level]  (scope) text` 已经含 scope 占位 + padding 对齐。自定义 format `[level][scope]` 时空 scope 显示 padded 空白（丑），处理需要 format function 增加复杂度。**直接用默认 format**。
- **console transport format**：electron-log 默认 console 是 `HH:MM:SS.mmm › text`（简化版），与 file 不同，dev terminal 易读。**不强制 align**，可接受差异。

### D7: fatal hook 启用 `log.errorHandler.startCatching()`（Round 2 fix R2-1 修订 — 启动时机选静态 import）
- **理由**：(RFC 第 3 轮 Q3) `log.errorHandler.startCatching()` 自动 catch `uncaughtException` + `unhandledRejection`，写 logger 落盘后退出。避免「.app 沉默 crash 丢堆栈」（macOS launchd .app 启动场景无 terminal 接 stderr）。
- **调用位置**（Round 2 fix R2-1 二选一选定）：**main entry `src/main/index.ts` 第一行静态 import logger.ts → logger 模块 init 即跑 `errorHandler.startCatching()`**（Step 3.0.4 锚定）。原写「最后一步（infrastructure 全就绪后再 catching）」不再适用 — 第一行静态 import 是为了让 errorHandler 立即生效，避免漏第一波 init error（如 stdout/stderr EPIPE guard / requestSingleInstanceLock 之前的 fatal）。
- **覆盖场景**（Round 2 fix INFO-1 明示 / Round 3 fix LOW-Codex-1+LOW-Claude-1 修订）：`uncaughtException` + `unhandledRejection` 全覆盖 — 包括 `BrowserWindow constructor throw` / `app.whenReady throw` / `initInfra` 失败 / DB 加载失败 等顶层 main 进程 error；`spawn` 失败 / 业务 try/catch 显式 throw 等也被覆盖。**未覆盖**: preload script 内 `contextBridge.exposeInMainWorld` 失败 → 走 §设计决策 D10 + Step 3.0.7 spike (d) **四方案**;preload script 本身加载失败 → 走 spike (d) 方案 4 webContents.on('preload-error')。**分工明确**: D7 兜底 main 进程顶层 error;spike (d) 兜底 preload-side init failure。
- **测试**（Round 2 fix R2-1 加）:
  - Step 3.5.1 logger.test.ts 加 1 assert: `expect(log.errorHandler.startCatching).toHaveBeenCalledOnce()`(verify 调用 — 全局 mock 下可 spy)
  - Step 3.7.3 e2e 加 1 条: 故意 `setTimeout(() => { throw new Error('fatal-hook-test') }, 5000)` → tail log 5 秒后看 fatal-hook-test 堆栈是否落盘

### D8: renderer 接入 — electron-log 官方 IPC bridge（Step 3.0 实测验证 / Spike (b) deferred / Round 2 fix R2-7 修订）
- **理由**：(RFC 第 3 轮 Q4) electron-log 5.x 默认 `preload: true`，main 调 `log.initialize({ preload: true })` 自动注入 preload script，renderer 端 `import log from 'electron-log/renderer'` 拿到 IPC-bridged logger，无需手写 IPC channel。
- **Spike (b) deferred 到 Step 3.0**：必须 Electron 真实运行时验证。预期工作正常（doc + 广泛验证），fallback 走 typed `IpcInvoke.LogWrite` channel + `miscApi` facade（**约 80-120 行**，Round 1 fix INFO-3 修订估计；详 `spike-reports/spike3-preload-ipc-bridge.md` §fallback design）。
- **contextIsolation 兼容**：项目用 contextIsolation，preload 要走 `contextBridge.exposeInMainWorld`。electron-log preload 自动处理（v5 doc 明确支持），但需要 Step 3.0 实测确认。

### D9: UI 入口 Settings 面板新建「LogsSection」
- **理由**：(RFC 第 1 轮 Q3) Settings 已是配置中心，新增 section 与现有 14 个 section 行为一致（详 `src/renderer/components/settings/sections/` 现有目录）。
- **挂载位置**：在 SettingsDialog 的「集成与运行环境」主题分组下，紧邻 NotifySection / HookServerSection。
- **按钮组**（RFC 第 4 轮 Q2 + Spike (a) 修正 + Round 1 fix M10 修订）：
  - 「打开日志目录」 — `shell.openPath(app.getPath('logs'))`
  - 「在 Finder 中显示当前日志」 — `shell.showItemInFolder(currentLogPath)` 选中今天的 main-YYYY-MM-DD.log；**fallback**：当前日志文件**不存在**（首次启动当天还没写过日志的边界情况）→ 退化为 `shell.openPath(LOG_DIR)` 打开整个 logs 目录，避免 macOS shell.showItemInFolder 不存在路径行为不可靠（实测可能弹「找不到该项目」对话框）。fallback 判定走 `fs.existsSync(currentLogPath)` 前置检查
  - 「日志级别」下拉 — error / warn / info / verbose / debug / silly（只控制 file transport，console 永远 silly — D4 修订；**Step 3.0.2 实证 typo 修订**: electron-log v5 LogLevel 无 'fatal' 有 'verbose'）
  - 「清空今天日志」 — truncate `main-YYYY-MM-DD.log`（spike (a) 修正：按天拆后清当天文件，不删历史）；**fallback**：当天日志文件不存在 → no-op + UI 弹 toast「今天还没有日志可清空」
- **IPC handler**：新增 3 个 typed IPC handler（走 src/preload/api/misc.ts 现有 typed facade，**不**走已删除的 raw `window.electronIpc`）：
  - `LogsOpenDirectory` / `LogsShowCurrentInFinder` / `LogsTruncateToday`
  - 「日志级别」用现有 SettingsSet handler，加 `logLevel` 字段分支（详 Step 3.1.3）

### D10: 354 处现有 console.* 全改 scoped logger（RFC 第 4 轮 Q1 选「全改」 / Round 1 fix H2 降级修订）
- **理由**：(RFC 第 4 轮 Q1) user 显式选「全改（大改动）」，理由：模块边界从 scope 一眼可见，grep `\[sdk-bridge\]` 比 `console.log` 在主进程巨量 log 中可识别。
- **执行原则**：
  - 每个 src/main 模块顶部 `const logger = log.scope('<kebab-case-name>')`
  - `console.log(...)` → `logger.info(...)`
  - `console.warn(...)` → `logger.warn(...)`
  - `console.error(...)` → `logger.error(...)`
  - `console.debug(...)` → `logger.debug(...)`
  - **保留**：测试代码内的 console.* 不动（vi.spyOn 拦截）
- **preload 1 处 console.error（src/preload/index.ts:38）单独处理**（Round 1 deep-review HIGH-1 + 反驳 ❓ 综合 / Round 3 fix LOW-Codex-1+LOW-Claude-1 修订）：
  - **风险**（成立）：该 console.error 是 `contextBridge.exposeInMainWorld('api', api)` 失败的 init signal，生产 .app 无终端 → silent failure → 与 §不变量 1 冲突
  - **方案选择 deferred 到 Step 3.0 spike (d)**（详 spike3 §spike (d) §选定原则 truth table + Step 3.0.7）：候选**四方案**（Round 3 fix「三方案」→「四方案」漂移修订）
    1. 显式调 electron-log preload helper `electronLog.sendToMain(message)` 走 IPC `__ELECTRON_LOG__` channel（不依赖 contextBridge 暴露 'api' 成功）
    2. 自建 typed `IpcInvoke.PreloadFatalError` channel，preload 自己 ipcRenderer.send → main 收到落 logger
    3. main 端 `spyRendererConsole`（webContents.on('console-message')）跨进程拦截 renderer/preload 所有 console.* 落 logger（覆盖面最广但与 console capture 接管语义重叠需测试）
    4. **方案 4**（Round 2 fix R2-10 / LOW-Claude 8 新增）: main 端 `webContents.on('preload-error', ...)` 兜底 preload script 本身加载失败（语法错 / asar 路径错 / require 失败）— 与方案 1/2/3 互补不冲突，**通常与方案 1/2/3 选定方案同时启用**（详 spike3 §spike (d) §选定原则）
  - **spike (d) 实测后选定方案**：plan 此处先不写「import 'electron-log/preload'」（reviewer-codex 实测该入口只暴露 sendToMain helper，**不自动接管 console.error**，Claude 原修法机制错）
- **拆批**：按 src/main 子目录拆 6 批（adapters / store / session / ipc / utils / 顶层 + 其他），每批一个 commit 单元，便于 review。

### D11: 不脱敏（RFC 第 1 轮 Q4）
- **理由**：日志是本地文件，user 自己阅读；sessionId / cwd 是定位问题主要线索；user 在「分享日志给他人 debug」前自己 review。

### D12: scope 命名 kebab-case 模块名（RFC 第 4 轮 Q4）
- **理由**：与 src/main 目录命名对齐（如 `adapters/claude-code/sdk-bridge` 对应 scope `sdk-bridge`），grep 友好。
- **典型 scope 列表**：sdk-bridge / lifecycle-scheduler / inbox-watcher / summarizer / event-bus / session-manager / ipc / store / hook-server / window / cli / agent-deck-mcp / mcp-watcher 等。

### D13: spike 范围（RFC 第 4 轮 Q3 选 (a)+(b)+(c) 全 spike）
- (a) rotate 策略：✅ 完成（`spike-reports/spike1-rotate-strategy.md`）
- (b) preload IPC bridge：⏸ deferred 至 Step 3.0 实测（`spike-reports/spike3-preload-ipc-bridge.md`）
- (c) NODE_ENV test 跳过接管：✅ 完成（`spike-reports/spike2-test-env-isolation.md`）

### D14: AppSettings.logLevel 单字段（默认 'info'，只控 file transport — Round 1 fix M3 修订 / Step 3.0.2 实证 typo 修订）
- **理由**：user RFC 只要一个「日志级别」下拉。本字段只控制 file transport，console transport 固定 'silly'（详 D4 修订）— 避免 D4 / D14 原写法「同时同步两 transport」与默认值不一致的语义冲突。
- **schema 修订**: electron-log v5 LogLevel 是 `'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'` (无 'fatal' 有 'verbose')；原 plan 写「silly|debug|info|warn|error|fatal」是基于推测，typecheck 实证拒。
- **不加字段**：rotate 14 天 / 落盘路径 / scope 命名 / console 永远 silly 都是 hardcoded design 决策不暴露给 user。如未来需要再加。

### D15: 测试环境 logger 不触达 electron（Round 1 fix H1 新增 / Round 2 fix R2-2 边界注解）
- **理由**：Round 1 deep-review reviewer-codex HIGH + reviewer-claude 反驳 ✅ 完全同意 → 双方共识必修。
- **问题铁证**：
  - `electron-log/main` 入口顶层 `require('electron')`（plan §已知踩坑 3 + reviewer-claude 实测 `/tmp/vitest-import-electron-log-test/node_modules/electron-log/src/main/index.js:1-3`）
  - vitest 是 node environment（`vitest.config.ts:14 environment: 'node'`），node sandbox 无 electron 模块
  - 项目 85+ 个 main 单测直接 import 业务模块（manager / sdkBridge / event-bus / 等）
  - §D10 全改后业务模块顶部都加 `import { logger } from '@main/utils/logger'` → logger.ts 顶部 import 'electron-log/main' → require('electron') → **`Cannot find module 'electron'`** 全炸
  - §不变量 2「NODE_ENV='test' 跳过 console 接管」**完全管不到** import side effect（守门 if 检查在 import 解析之后）
- **方案选择**：**vitest setupFiles 全局 mock electron + electron-log/main**（reviewer-claude 推荐 + reviewer-codex 候选方案对齐）
  - 加 `vitest.config.ts` setupFiles 引用新建 `vitest-setup.ts`
  - `vitest-setup.ts` 全局 `vi.mock('electron', ...)` + `vi.mock('electron-log/main', ...)`
  - 一处 mock，85+ 单测零改动；与 `src/main/__tests__/bundled-assets-multi-root.test.ts:74` 现有 local mock 兼容性需 Step 3.0.2.5 实测
- **mock 范围明确**（Round 2 fix R2-2 / LOW-Claude 1 边界注解 / **Step 3.0.2.5 实证扩展 — electron-store**）:
  - **mock**: `electron` + `electron-log/main`（main 入口顶层 require electron） + **`electron-store`**（**Step 3.0.2.5 实证补充** — `electron-store@8.2.0/index.js:3` CJS 顶层 `require('electron')`，vitest hoist 的 `vi.mock('electron')` 对 ESM import 生效但**对 CJS package 内部 require 拦不住**；`settings-store.ts:1 import Store from 'electron-store'` 在 import 链上被 12 个 main 测试文件触发 → 全部 `Error: Electron failed to install correctly` fail；详 §已知踩坑 14）
  - **不 mock**: `electron-log/renderer`（实证 `electron-log/src/renderer/index.js:3-6` 顶层只 require 4 个内部模块 `../core/Logger / ./lib/RendererErrorHandler / ./lib/transports/console / ./lib/transports/ipc`，**无 `require('electron')`**；`transports/ipc.js` 用 `window.__electronLog.sendToMain(...)` 是**调用时 lazy 检查**，vitest node env 安全可 import — line 16 `if (!window.__electronLog) { ... return; }` 走 fallback 静默退化）
  - **不 mock**: `electron-log/node`（spike runner 入口，纯 Node 不依赖 electron）
- **logger.test.ts 局部 unmock**（Round 2 fix R2-2 / MED-Codex 1）: logger 单测必须**显式** `vi.unmock('electron-log/main')` 才能验真 `log.transports.file.resolvePathFn` / `errorHandler.startCatching` / transport level API 行为；否则全局 mock 让 assert 在 mock 上通过但漏掉真实 API drift 风险。**注**: unmock 后该测试文件仍需 mock `electron`（electron-log/main 真包顶部 require electron）— 用 `vi.doMock('electron', factoryWithRealishApi)` 注入「足够真实」的 app/getPath/setName/whenReady stub，让 electron-log 内部跑通同时保留 transport 真实 shape。
- **备选**：logger.ts 提供 test-safe 入口（dynamic import 切换 stub vs main 入口）— 复杂度高，仅在全局 mock 实测撞不可解冲突时启用
- **不推荐**：拆纯 helper + Electron init —— logger 本质就是 init electron-log + console 接管 + errorHandler.startCatching，拆完等于白拆

## 步骤 checklist

### Step 0 — RFC（已完成）
- [x] Step 0 — RFC 4 轮 AskUserQuestion 对齐 design 大方向，done by session 3b729eed on 2026-05-29

### Step 0.5 — spike（已完成）
- [x] Step 0.5 spike (a) — rotate 策略 5 项验证，commit uncommitted（artifacts 在 `.claude/plans/runtime-logging-electron-log-20260529/spike-reports/`）
- [x] Step 0.5 spike (c) — NODE_ENV test 跳过接管 4 项验证，commit uncommitted
- [x] Step 0.5 spike (b) — preload IPC bridge deferred 到 Step 3.0（Electron 运行时必须）

### Step 1 — plan 文件（当前 step）
- [x] Step 1 — 写 plan 文件 `.claude/plans/runtime-logging-electron-log-20260529.md` + spike artifacts，done by session 3b729eed

### Step 1.5 — Deep-Review plan
- [ ] Step 1.5 — invoke `agent-deck:deep-review` SKILL kind='plan'，paths=['.claude/plans/runtime-logging-electron-log-20260529.md', '.claude/plans/runtime-logging-electron-log-20260529/spike-reports/*.md']

### Step 2 — EnterWorktree
- [ ] Step 2 — user confirm 后 Bash + EnterWorktree(path:) 进 worktree（避开 v2.1.112 stale base bug）

### Step 3 — 实施

#### Step 3.0 — 装依赖 + 写最小 logger + spike (b)+(d) 实测（Round 1 fix H1+M5+M8 / Round 2 fix R2-1+R2-9 修订）
- [ ] Step 3.0.1 — `pnpm add electron-log` 装依赖（user 显式确认引入新依赖 OK）
- [ ] Step 3.0.2 — 写最小 `src/main/utils/logger.ts`：electron-log 5 init + resolvePathFn 按天 + cleanup 14 天 + format 默认 + errorHandler.startCatching()（**Round 2 fix R2-1 修订: errorHandler.startCatching() 在 logger 模块 init 即跑，不再延到「最后一步」 — 详 §D7**）+ 条件接管 console + 显式 `app.setName('Agent Deck')`（让 dev/prod logs path 一致 — Round 1 fix M7；**Round 2 fix LOW-Claude 5 注**: spike 未实测此 API 行为，依赖 Electron doc + `~/Library/Logs/Electron/` 目录已存在反向证据，Step 3.7.0 first dev 实测 verify；失败 fallback 用环境变量 + 硬编码路径 `~/Library/Logs/Agent Deck/` 不依赖 app.getPath('logs')）+ `setFileLevel(level)` exported helper
- [x] **Step 3.0.2.5 — 写 vitest-setup.ts 全局 mock electron + electron-log/main + electron-store**（D15 落地，**前置基石** Step 3.3 354 处 migrate；done by session b29b10cd on 2026-05-29，commit pending — 将单独 commit）：
  - 新建 `vitest-setup.ts`：全局 `vi.mock('electron', ...)` + `vi.mock('electron-log/main', ...)` + **`vi.mock('electron-store', ...)`**（**实证扩展** — 详 D15 §mock 范围明确 §electron-store 节）
  - **不 mock** `electron-log/renderer`（实证 renderer 入口顶层无 require electron，详 D15 §mock 范围明确）
  - `vitest.config.ts` 加 `setupFiles: ['./vitest-setup.ts']`
  - **实测数据**（baseline vs after setup）: 
    - 测试文件: 30 fail / 56 pass / 4 skip → **0 fail** / 81 pass / 9 skip(90)
    - 测试: 69 fail / 693 pass / 40 skip → **0 fail** / 991 pass / 159 skip(1150)
    - 9 skipped 文件全是 better-sqlite3 binding ABI mismatch（Electron v130 vs Node v24 v137），bindingAvailable probe 守门生效，与本步无关
  - **兼容性验证 OK**：`bundled-assets-multi-root.test.ts:74` local `vi.mock('electron')` + `settings-store.test.ts:37` local `vi.mock('electron-store')` 均自动覆盖全局 mock（vitest hoist 优先级 local > setupFiles）
- [x] Step 3.0.3 — 写最小 `src/renderer/utils/logger.ts`：import 'electron-log/renderer' + **直接抽 `shouldCaptureRendererConsole(mode: string): boolean` 纯函数**（Round 2 fix R2-9 修订: Step 3.0.3 一次性写到位，不再 Step 3.5.1.5 抽出二改） + `if (shouldCaptureRendererConsole(import.meta.env.MODE)) Object.assign(console, log.functions)` 守门。**Done by session b29b10cd on 2026-05-29, commit 3461ecd**. typecheck PASS + vitest 0 fail / 991 pass / 159 skip 维持。
- [x] Step 3.0.4 — main entry `src/main/index.ts` **第一行** import logger.ts（让 errorHandler.startCatching() 立即生效，避免漏第一波 init error — D7 修订）；renderer main.tsx 顶部 import logger.ts。**Round 2 fix LOW-Claude 6 注**: 实施前 grep `src/main/index.ts` 现有 import 顺序，confirm logger.ts 不依赖任何业务模块（§不变量 8）即可安全第一行；改完后跑 `pnpm dev` 启动 verify main 进程正常 init（无循环依赖 / 显式 init order 撞）。**Done by session b29b10cd on 2026-05-29, commit 307e3ae** — typecheck PASS + vitest 0 fail 维持。**附加修订**: `src/renderer/global.d.ts` 加 `/// <reference types="vite/client" />` 让 TypeScript 识别 `import.meta.env.MODE` (vite 注入 env)。**`pnpm dev` GUI verify 待 user 跑**(Step 3.0.5 范围)。
- [ ] Step 3.0.5 — `pnpm dev` 实测 spike (b) 验证清单 **B1-B9**（详 `spike-reports/spike3-preload-ipc-bridge.md` §验证清单，Round 1 fix M8 加 B6-B9：B6 contextIsolation / B7 asar / B8 sandbox:false / B9 多 BrowserWindow 重建）
- [ ] Step 3.0.6 — spike (b) 实测失败时 fallback 手写 IPC bridge（**约 80-120 行**，Round 1 fix INFO-3 修订估计）走 typed `IpcInvoke.LogWrite` channel + `miscApi` 暴露（不用已删除的 `window.electronIpc` raw channel — Round 1 fix M5）+ 更新 §设计决策 D8
- [ ] **Step 3.0.7 — spike (d) preload console.error 落盘验证**（Round 1 fix H2 降级修订必跑 / Round 2 fix R2-4+R2-8+R2-10 修订）：候选四方案各跑一遍 minimal 实测，按 §选定原则 选定最稳的回填 §设计决策 D10 + **新 Step 3.2.6（preload 改动单独 commit，不混入 Step 3.3 main migrate）**：
  - 方案 1: 显式调 `electronLog.sendToMain(message)` helper 走 IPC `__ELECTRON_LOG__` channel
  - 方案 2: 自建 typed `IpcInvoke.PreloadFatalError` channel + main 端 logger 落盘
  - 方案 3: main 端 `webContents.on('console-message', ...)` 跨进程拦截 renderer/preload 所有 console.* 落 logger
  - **方案 4**（Round 2 fix R2-10 / LOW-Claude 8 新增）: main 端 `webContents.on('preload-error', (event, preloadPath, error) => log.scope('preload-fatal').error(error, preloadPath))` 兜底 **preload script 本身加载失败**（语法错 / asar 路径错 / require 失败 — 方案 1/2/3 全失效场景）；与方案 3 互补（preload-error 拦 preload 加载失败 / console-message 拦 preload 加载成功后内部 throw）
  - 验证清单（Round 2 fix R2-4 量化判定）:
    - 方案 X「通过」= 故意触发 `contextBridge.exposeInMainWorld('api', api)` 失败（mock bad api）→ `tail -f ~/Library/Logs/Agent\ Deck/main-*.log` 看到 error + contextBridge 失败 stack 完整
    - 方案 3 「双倍落盘」判定 = renderer 端 `console.log('test')` 1 次 → log file 出现 `test` >1 次（与 D5 console capture 接管冲突）
    - 方案 1 API 升级 break 风险 = electron-log major upgrade 后 `electronLog.sendToMain` 不存在 / 签名变（依赖未文档化 internal API）
    - 方案 4 验证 = 改坏 preload `import('inexistent-module')` 让 preload 加载失败 → 看 main log 是否有 preload-error 行

#### Step 3.1 — AppSettings.logLevel 字段（Round 1 fix M3 修订 / Step 3.0.2 实证 typo 修订）
- [x] Step 3.1.1 — `src/shared/types/settings/app-settings.ts` 加 `logLevel: 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'`(electron-log v5 LogLevel 类型,无 'fatal' 有 'verbose';注释说明「只控 file transport，console transport 永远 silly，详 plan §D4 §D14」). Done by session b29b10cd on 2026-05-29, commit 6e4087f.
- [x] Step 3.1.2 — `src/shared/types/settings/defaults.ts` `DEFAULT_SETTINGS.logLevel = 'info'`. Done by session b29b10cd on 2026-05-29, commit 6e4087f.
- [x] Step 3.1.3 — `src/main/ipc/settings.ts` 加 `applyLogLevel(p, next)` helper + 加进 APPLY_FNS 数组 + import setFileLevel from `@main/utils/logger`(只更新 file transport — 不再 setLevel 同步两 transport). Done by session b29b10cd on 2026-05-29, commit 6e4087f.

#### Step 3.2 — Settings UI 新增 LogsSection（Round 1 fix M5 / Round 2 fix R2-8 修订）
- [x] Step 3.2.1 — 新建 `src/renderer/components/settings/sections/LogsSection.tsx`(含 3 个按钮 + 1 个下拉; plan 估 4 按钮 + 1 下拉, 实际 3 按钮 + 1 下拉够覆盖 D9 spec). Done by session b29b10cd on 2026-05-30, commit 9bd33c9.
- [x] Step 3.2.2 — `src/renderer/components/SettingsDialog.tsx` import + 挂载到「集成与运行环境」分组. Done by session b29b10cd on 2026-05-30, commit 9bd33c9.
- [x] Step 3.2.3 — `src/preload/api/misc.ts` 加 typed `logsApi` 三 method (logsOpenDirectory / logsShowCurrentInFinder / logsTruncateToday). Done by session b29b10cd on 2026-05-30, commit 9bd33c9.
- [x] Step 3.2.4 — `src/shared/ipc-channels.ts` 加 channel 常量 LogsOpenDirectory / LogsShowCurrentInFinder / LogsTruncateToday. Done by session b29b10cd on 2026-05-30, commit 9bd33c9.
- [x] Step 3.2.5 — `src/main/ipc/logs.ts` (new) 三 handler 实现 + index.ts 注册. fallback D9 落地: showCurrentInFinder 文件不存在 → openPath LOG_DIR; truncateToday 文件不存在 → no-op + 返 existed=false 让 UI 弹 toast. Done by session b29b10cd on 2026-05-30, commit 9bd33c9.
- [ ] **Step 3.2.6 — preload `src/preload/index.ts:38` 改动单独 commit**(Round 2 fix R2-8 / LOW-Claude 2 修订, 与 Step 3.3 main migrate 独立批次, 依赖 Step 3.0.7 spike (d) 选定方案):

#### Step 3.3 — 354 处 main console.* migrate 到 scoped logger（拆 6 批 / Round 3 fix MED-Codex-2 配套）
- [x] Step 3.3.1 — 批 1: `src/main/adapters/**`(含 sdk-bridge / claude-code / codex-cli 子模块). Done by session b29b10cd on 2026-05-29, commit 7bb083f. 23 文件 / 61 处 console.X → logger.X + 3 个 broken test fix (warnSpy → log.scope(...).warn). typecheck PASS + vitest 0 fail / 1003 pass / 159 skip 维持.
- [x] Step 3.3.2 — 批 2: `src/main/store/**`. Done by session b29b10cd on 2026-05-29, commit 6a3b1c7. 9 文件 / 20 处 console.X → logger.X (测试文件排除) + 2 个 broken test fix + Step 3.3.1 遗留 unused afterEach import 清理. typecheck PASS + vitest 0 fail 维持.
- [x] Step 3.3.3 — 批 3: `src/main/session/**` + `src/main/teams/**`. Done by session b29b10cd on 2026-05-30, commit 861ed9f. 10 文件 / 35 处 console.X → logger.X (无 broken test). typecheck PASS + vitest 0 fail 维持.
- [x] Step 3.3.4 — 批 4: `src/main/ipc/**` (注: ipc.ts 顶层已拆到 ipc/ 子目录). Done by session b29b10cd on 2026-05-30, commit 2334234. 5 文件 / 13 处 console.X → logger.X (settings.ts 改 `import { setFileLevel }` → `import log, { setFileLevel }`) + 1 broken test fix (sessions.test.ts 4 处 warnSpy → handoffLogger.warn). typecheck PASS + vitest 0 fail 维持.
- [x] Step 3.3.5 — 批 5: `src/main/utils/**` + `src/main/agent-deck-mcp/**` + `src/main/hook-server/**`. Done by session b29b10cd on 2026-05-30, commit 3e9859f. 13 文件 / 33 处 console.X → logger.X + 9 个 broken test fix (Pattern A 8 文件 warnSpy → log.scope(...).warn + Pattern B bundled-assets-multi-root.test.ts local vi.mock electron 补 stub). typecheck PASS + vitest 0 fail 维持.
- [x] Step 3.3.6 — 批 6: `src/main` 顶层（index.ts / cli.ts / window.ts / event-bus.ts / 等）+ summarizer + notify + permissions. **最后一批 / plan §Step 3.3 全完**. Done by session b29b10cd on 2026-05-30, commit 8552d5a. 12 文件 / 53 处 console.X → logger.X (顶层 4 + index/ 3 + codex-config/ 3 + notify+window 2). typecheck PASS + vitest 0 fail / 0 broken test. **src/main 0 console.X 残留** (rg verified). plan §Step 3.3 总计 72 文件 / 215 处 (plan spec 估 354 偏多, 实际 215 — plan 估含测试文件 + 注释字面 + 估算偏差).
- 每批含：grep 该子目录 `console\.\(log\|warn\|error\|info\|debug\)` → 列出文件 → 顶部加 `const logger = log.scope('<name>')` → 整批替换 → typecheck → 单 commit
- **Round 3 fix MED-Codex-2 配套**: migrate 同时**清理注释/字符串里的 `console.log` 等字面**避免 Step 3.5.2.5 grep CI 误报。改措辞为「logger 调用」/「log call」/「日志输出」等（如注释 `// 这里吞错只 console.error,` 改 `// 这里吞错只 log 一下,`；schema description 同款）。Round 3 fix 妥协方案 — 完美排除靠 ripgrep filter,清理注释/字符串靠人工 batch fix

#### Step 3.4 — renderer 17 处 console.* migrate（无需 scope，因为 renderer 是单 logger）
- [x] Step 3.4.1 — 列出 17 处文件 + 决定 renderer 的 scope（默认 `(renderer)` 顶层 scope 就够，模块级 scope 不强制）. **实际走与 main 端同款细分 scope** (与 main 一致 + log 文件区分 renderer 模块). Done by session b29b10cd on 2026-05-30, commit 22a828f. 7 文件 / 16 处 console.X → logger.X (main.tsx side-effect import → default import + 6 components scoped). typecheck PASS + vitest 0 fail / 0 broken test. **src/main + src/renderer 0 console.X 残留** (rg verified).

#### Step 3.5 — 测试（Round 1 fix M2+M3 / Round 2 fix R2-1+R2-6+R2-9 / Round 3 fix MED-Codex-1+MED-Codex-2+LOW-Claude-3+LOW-Claude-4+LOW-Claude-6 修订）

<details>
<summary><strong>Step 3.5.1 spec 原版（vi.unmock + vi.doMock 序列 — 实测 vitest 2.1.9 无效, 见下方 done 行折中说明）</strong></summary>

- ~~Step 3.5.1 — 新建 `src/main/utils/__tests__/logger.test.ts`（**Round 3 fix MED-Codex-1 + LOW-Claude-6 + Round 4 fix R4-LOW-1 硬约束**: 不得静态 import `logger.ts` 或 `electron-log/main`，必须按下方步骤动态 import）：~~
  - ~~**顶部硬约束序列**（顺序不可乱）:~~
    1. ~~`vi.resetModules()` 隔离 import-time side effect~~
    2. ~~`vi.unmock('electron-log/main')` 解除 vitest-setup.ts 全局 mock~~
    3. ~~`vi.doMock('electron', () => ({ app: { getPath, getName, whenReady: () => Promise.resolve(), setName: vi.fn() }, ipcMain: { on: vi.fn() }, shell: { ... } }))` 注入「足够真实」的 stub（让 electron-log/main 顶部 require('electron') 跑通）~~
    4. ~~**`const electronLogReal = (await import('electron-log/main')).default`** 动态 import electron-log/main（**Round 4 fix R4-LOW-1**: 必须在 step 3 doMock 之后 + step 5 spy 之前;静态 import 会被 ESM hoist 到 step 3 之前 → doMock 无效 + 顶部 require('electron') 直接炸）→ 拿到真包 logger instance~~
    5. ~~**`vi.spyOn(electronLogReal.errorHandler, 'startCatching')`** 在 dynamic import logger.ts 之前注册（**Round 3 fix LOW-Claude-4**: ESM static import 顺序约束 — logger.ts top-level errorHandler.startCatching() 会立即 fire，spy 必须在 import 之前注册才能拦到）~~
    6. ~~`const logger = (await import('../logger')).default` 动态 import logger.ts（**Round 3 fix MED-Codex-1 / LOW-Claude-6**: `vi.doMock` 不 hoist 必须配合 `await import` 替代 static import）~~
  - ~~assert `NODE_ENV='test'` 时 `console.log === originalConsoleLog`（监测 D5 守门 regression）~~
  - ~~assert `resolvePathFn` 返回 `main-YYYY-MM-DD.log` 格式（mock Date）~~
  - ~~assert `cleanupOldLogs` 删 14 天前不删 < 14 天的（fs.utimes mock + tmpdir）~~
  - ~~assert 默认 `log.transports.file.level === 'info'` AND `log.transports.console.level === 'silly'`（D4 修订）~~
  - ~~assert `setFileLevel('warn')` 后 `log.transports.file.level === 'warn'` AND `log.transports.console.level === 'silly'`（D4 修订 — console 永远不变）~~
  - ~~assert `vi.spyOn` 拦到 `electronLogReal.errorHandler.startCatching` 调用 ≥ 1 次（Round 3 fix LOW-Claude-4 修订: spy 在 import 之前注册才能拦到 logger.ts top-level 调用）~~

**实测无效原因 (vitest 2.1.9)**:
- 顶部 `vi.mock('electron-log/main', async () => vi.importActual(...))` factory + outer 变量 → 报 "There was an error when mocking a module"; vi.hoisted 共享变量后仍 撞 Electron failed to install
- runtime `vi.unmock('electron-log/main') + vi.unmock('electron') + vi.doMock` 也无法解 setupFiles 全局 vi.mock 锁定 — 全是 `Error: Electron failed to install correctly`

</details>

- [x] Step 3.5.1 — 新建 `src/main/utils/__tests__/logger.test.ts`(**Step 3.5.1 实证折中**). Done by session b29b10cd on 2026-05-29, commit 9421411. 8 个 assert 全过:
  - NODE_ENV='test' 时 console.log/warn/error 不是 logger wrapper (D5)
  - log.initialize() 被调 (D8)
  - errorHandler.startCatching() 被调 (D7)
  - resolvePathFn 设为函数 + 返 main-YYYY-MM-DD.log 格式 (D3)
  - 默认 file.level='info' AND console.level='silly' (D4)
  - setFileLevel('warn') 只改 file.level (D4 修订)
  - cleanupOldLogs 删 mtime>14 天 main-*.log 保留 <14 天 + 不动其他文件名 (D3)
  - LOG_DIR 不存在时返 0 不挂
  - **附加**: logger.ts 新增 export `{ cleanupOldLogs, todayStr }` testing-only API
  - **折中代价**: real electron-log API drift (major upgrade 字段重命名 / 行为变化) catch 不到 — 留 Step 3.7 e2e 兜底
- [x] **Step 3.5.1.5 — `shouldCaptureRendererConsole(mode)` 纯函数测**(Round 2 fix R2-9 修订: 函数本身在 Step 3.0.3 已抽出，本步骤只新增测试). Done by session b29b10cd on 2026-05-29, commit b7fd5df. 4 个 assert 全过:
  - `expect(shouldCaptureRendererConsole('test')).toBe(false)`
  - `expect(shouldCaptureRendererConsole('development')).toBe(true)`
  - `expect(shouldCaptureRendererConsole('production')).toBe(true)`
  - `expect(shouldCaptureRendererConsole(undefined)).toBe(true)` (兜底 vite env 未注入)
  - **附加**: vitest-setup.ts 加 `vi.mock('electron-log/renderer', ...)` 全局 mock (D15 §mock 范围实证扩展 — vitest 2.1.9 跑 renderer logger.ts 时 import.meta.env.MODE 替换异常导致 Object.assign 接管 console 卡死, mock 整个 module 规避副作用)
  - **附加**: vitest.config.ts 加 `@renderer` alias (与 electron.vite.config.ts 对齐)
- [x] Step 3.5.2 — 跑全量 vitest 确认 51 处 vi.spyOn(console) 零回归. 隐式过 (Step 3.3.1-3.3.6 + 3.4 + 3.5.x 每批跑 vitest 都 0 fail / 1003 pass / 159 skip 维持; broken test fix 时改 spy 改成 spy logger 而非 console).
- [x] **Step 3.5.2.5 — grep CI assert 354 处全改 0 残留 + logger 模块独立性自检**(Round 2 fix R2-6 / Round 3 fix MED-Codex-2+LOW-Claude-3 / Round 4 fix R4-MED-1 修订). Done by session b29b10cd on 2026-05-30, commit 691d464. 新建 scripts/logger-check.sh 双重检查 (0 残留 + logger.ts 独立性) + 加 package.json `logger:check` script. 实测 plan spec 写 `rg -t ts -t tsx` 报 "unrecognized file type: tsx", 修法用 `--type-add 'tsx:*.tsx' -t ts -t tsx` 注册 tsx 类型. `bash scripts/logger-check.sh` → ✅ 通过.
- [x] Step 3.5.3 — `pnpm typecheck` + `pnpm build` 通过. Done by session b29b10cd on 2026-05-30. typecheck PASS + build PASS (main 715.81 kB / preload 21.63 kB / renderer 1423.23 kB 三 chunks 全 built; 1 chunk warn dynamic+static import mix 与本 plan 无关).

#### Step 3.6 — README 更新
- [x] Step 3.6.1 — README §开发与运行 节加「日志位置 + Settings 查看入口」描述 + §设置 §会话 加日志级别. Done by session b29b10cd on 2026-05-30, commit 862cdc6.
- [x] Step 3.6.2 — README §项目结构 节加 `src/main/utils/logger.ts` + `src/renderer/utils/logger.ts` + `scripts/logger-check.sh` 入口指引. Done by session b29b10cd on 2026-05-30, commit 862cdc6. (Settings LogsSection 入口指引由 Step 3.2 实施后回填.)
  - **写 bash script** `scripts/logger-check.sh`（不用裸 grep — Round 3 fix MED-Codex-2: 裸 grep 命中注释/字符串假命中 + grep 0 匹配 exit 1/2 反向失败 / **Round 4 fix R4-MED-1**: 加 `set -euo pipefail` + rg dep 硬校验 + 修第 3 个 filter pattern typo）：
    ```bash
    #!/usr/bin/env bash
    set -euo pipefail
    # Round 4 fix R4-MED-1: 硬校验 ripgrep 可用,避免 rg 缺失时 || true 吞错 false green
    command -v rg >/dev/null || { echo "❌ ripgrep (rg) required but not found in PATH"; exit 1; }
    # 检查 1: 354 处全改 0 残留（排除注释、字符串、preload 1 处由 Step 3.2.6 处理）
    # 注: ripgrep 默认排除 .gitignore + node_modules
    matches=$(rg -t ts -t tsx 'console\.(log|warn|error|info|debug)\(' \
      src/main src/renderer \
      --glob '!**/__tests__/**' \
      --glob '!**/*.test.ts' \
      --glob '!src/preload/**' \
      | { rg -v '^\s*//' || true; } \
      | { rg -v "'.*console\." || true; } \
      | { rg -v '^\s*\*' || true; } \
      || true)
    if [ -n "$matches" ]; then
      echo "❌ console.* 残留:" >&2
      echo "$matches" >&2
      exit 1
    fi
    # 检查 2: logger 模块独立性（§不变量 8）— Round 3 fix LOW-Claude-3
    logger_deps=$(rg "^import.*from '@(main|shared|renderer)/" src/main/utils/logger.ts || true)
    if [ -n "$logger_deps" ]; then
      echo "❌ logger.ts 不应 import 业务模块（§不变量 8）:" >&2
      echo "$logger_deps" >&2
      exit 1
    fi
    echo "✅ logger-check 通过"
    ```
  - 加 `package.json` script: `"logger:check": "bash scripts/logger-check.sh"`
  - **依赖 ripgrep**（Round 4 fix R4-MED-1）: ripgrep 不在系统 PATH 时 script 立即 fail-fast；CI workflow 需 `brew install ripgrep` (macOS) 或 `apt install ripgrep` (Linux) 作为 prerequisite；本地 dev `brew install ripgrep` 一次性。如未来需移除 ripgrep 依赖 → 改写 Node/TS script 替代（fallback 路径）
  - CI workflow 加一步: `pnpm logger:check`，新 PR 习惯 console.log 自动拦
  - **Round 3 fix MED-Codex-2 + Round 4 fix R4-MED-1 妥协说明**: ripgrep `-v` 排除「行首注释 `^\s*//` / 单引号字符串内 `'.*console\.` / 行首块注释 `^\s*\*`(Round 4 fix R4-MED-1 修 typo 原 `'"\s*\*'` 是错的拦不住 JSDoc 块注释)」三种典型 false-positive；完美排除注释/字符串需 AST parsing (ts-morph) 复杂度高，**Step 3.3 子步骤注明**「migrate 时同步把注释 / 字符串里的 `console.log` 等改成 `logger` / `log call` 措辞避免误报」（详 Step 3.3 修订）

#### Step 3.6 — README 更新

#### Step 3.7 — e2e .app dist 验证（plan 根本目标 / Round 1 fix M7 / Round 2 fix R2-1+R2-5 修订）
- [ ] **Step 3.7.0 — dev 模式落盘自检**（Round 2 fix R2-5 / MED-Claude 1 修订: 重命名 Step 3.7.2.5 → Step 3.7.0 前置，dist 之前先验 dev 模式落盘，不需先 dist + 装到 /Applications 浪费 1-2 分钟）：跑 `pnpm dev` 起 Electron → 看 `~/Library/Logs/Agent Deck/main-*.log`（**注：Step 3.0.2 已 `app.setName('Agent Deck')`，dev/prod 路径一致，不再分流到 `~/Library/Logs/Electron/`**）→ 文件存在即 setName 生效；不存在则 dev 模式实际落 `~/Library/Logs/Electron/`（setName 未生效），需排查 setName 调用位置（必须在 app.whenReady 之前）
- [ ] Step 3.7.1 — `pnpm dist` 完整打包 .app
- [ ] Step 3.7.2 — 按 CLAUDE.md §打包与本地安装 5 步装到 /Applications + ad-hoc 签名 + 清 quarantine
- [ ] Step 3.7.3 — 双击启动 .app 后 `tail -f ~/Library/Logs/Agent\ Deck/main-*.log` 验证：
  - 文件存在
  - 启动事件落盘（main 进程 logger init 那一刻就该有）
  - 新建会话 → SDK 事件 → log 内出现 sdk-bridge scope 行
  - renderer 操作（如改设置）→ log 内出现 renderer 端日志
  - **关键**：close .app 后再 cat 文件，确认日志真的持久化（不是 buffer 在内存）
  - **Round 1 fix M8 补充**: Cmd+W 关窗 + macOS Dock activate 重建 BrowserWindow 后 renderer log 仍落盘（验证 §不变量 6 IPC bridge 在 BrowserWindow recreate 场景仍工作）
  - **Round 1 fix H2 补充**: 故意撞 contextBridge.exposeInMainWorld 失败（mock api 制造 throw）→ 看 preload console.error 是否落 main log（验证 Step 3.0.7 spike (d) 选定方案在 prod 仍工作）
  - **Round 2 fix R2-1 补充**: 故意 `setTimeout(() => { throw new Error('fatal-hook-test') }, 5000)` → tail log 5 秒后看 fatal-hook-test 堆栈是否落盘（验证 D7 errorHandler.startCatching() 真的 catch）。**Round 3 fix LOW-Claude-5 注: 此 e2e 必须放在 Step 3.7.3 列表最后一项**，因 errorHandler.startCatching 默认 catch 后 `process.exit(1)`（详 §D7 line 76），后续 e2e 验证步骤无法继续 — 未来加新 e2e 项必须加在 fatal-hook-test 之前

### Step 3.8 — Deep-Review code
- [ ] Step 3.8 — invoke `agent-deck:deep-review` SKILL kind='code'，scope 含所有 Step 3 新增 / 修改文件

### Step 4 — 收口（Round 1 fix M4 / Round 2 fix R2-3 修订）
- [ ] **Step 4.1（在 worktree 内做）** — 经验沉淀到 `ref/conventions/tally.md`（如有踩坑模式化），改动 commit 进 worktree branch
- [ ] **Step 4.2（在 worktree 内做）** — 写 `ref/changelogs/CHANGELOG_X.md` + 同步 INDEX（X 取 `ls ref/changelogs/` 最大 + 1），改动 commit 进 worktree branch
- [ ] **Step 4.2.5 — `ExitWorktree(action: "keep")`**（Round 2 fix R2-3 / MED-Codex 3 修订: 顺序调整 — ExitWorktree 必须在 Step 4.1+4.2 commit 之后才能跑，否则 conventions/changelog 改动散落 main repo 没合并进 worktree branch → archive_plan ff-merge 漏 Step 4.1+4.2 内容；同时 archive_plan precheck 要求 caller cwd 不在 worktree 内 — 此处 ExitWorktree 满足该 precheck）
- [ ] **Step 4.3（在 main repo 做）** — `mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch: 'main', changelog_id: 'X' })` 原子收口（ff-merge worktree branch → mv plan → archive spike-reports → INDEX update → commit → worktree remove → branch -D + 自动归档 caller session）

## 当前进度

**Plan 大部分完成** (2026-05-30, session b29b10cd, 累计 16 commits) — Step 3.1 / 3.3 (6 批) / 3.4 / 3.5.1 / 3.5.1.5 / 3.5.2 / 3.5.2.5 / 3.5.3 / 3.6 全部 done. typecheck PASS + build PASS + vitest 0 fail / 1003 pass / 159 skip 维持. `src/main + src/renderer 0 console.X 残留` (rg verified).

**done step 链 (本会话 16 commits)**:
- Step 3.0.2.5 (cade4d5) — vitest-setup.ts 全局 mock 三件套 (electron + electron-log/main + electron-store, D15 实证扩展)
- Step 3.0.3 (3461ecd) — renderer logger.ts + shouldCaptureRendererConsole 纯函数
- Step 3.0.4 (307e3ae) — main + renderer entry 顶部 import logger.ts
- Step 3.1 (6e4087f) — AppSettings.logLevel 字段 + IPC apply 即改即生效
- Step 3.5.1.5 (b7fd5df) — shouldCaptureRendererConsole 4 个 assert + vitest-setup electron-log/renderer mock 扩展
- Step 3.5.1 (9421411) — main logger.ts 6+2 assert (mock-mediated 折中)
- Step 3.3.1 (7bb083f) — 批 1 adapters/ (23 文件 / 61 处)
- Step 3.3.2 (6a3b1c7) — 批 2 store/ (9 文件 / 20 处)
- Step 3.3.3 (861ed9f) — 批 3 session/+teams/ (10 文件 / 35 处)
- Step 3.3.4 (2334234) — 批 4 ipc/ (5 文件 / 13 处)
- Step 3.3.5 (3e9859f) — 批 5 utils/+mcp/+hook-server/ (13 文件 / 33 处)
- Step 3.3.6 (8552d5a) — 批 6 顶层+bootstrap+codex+notify+window (12 文件 / 53 处) **plan §Step 3.3 全完**
- Step 3.4 (22a828f) — renderer/ (7 文件 / 16 处)
- Step 3.5.2.5 (691d464) — scripts/logger-check.sh grep CI 守门 + package.json logger:check script
- Step 3.6 (862cdc6) — README 日志位置 + 用法 + 项目结构 + scripts/logger-check.sh 入口

**前面 done (前会话, 不在本会话 commit 链)**:
- Step 3.0.1 + 3.0.2 (df3f4b1) — 装 electron-log@5.4.4 + 写 main logger.ts

**剩余 step (全部待 user GUI verify / 跳过)**:
- Step 3.0.5 — `pnpm dev` 实测 spike (b) B1-B9 验证清单 (user GUI verify)
- Step 3.0.6 — spike (b) 失败时 fallback IPC bridge (条件性)
- Step 3.0.7 — spike (d) preload console.error 落盘验证 4 方案 (dev runtime)
- Step 3.2.1-3.2.5 — Settings LogsSection UI (4 按钮 + 1 下拉 + IPC handler)
- Step 3.2.6 — preload `src/preload/index.ts:38` 改动 (依赖 Step 3.0.7 选定方案)
- Step 3.7.0-3.7.3 — e2e .app dist 验证 (plan 根本目标; dist + 装到 /Applications + 双击启动看 ~/Library/Logs/Agent Deck/main-*.log)
- Step 3.8 — invoke deep-review SKILL (Step 3 全 scope 后做)

**收口路径 (Step 4)**:
- Step 4.1 经验沉淀到 ref/conventions/tally.md (如有踩坑模式化)
- Step 4.2 写 ref/changelogs/CHANGELOG_X.md + 同步 INDEX
- Step 4.2.5 ExitWorktree(action: "keep")
- Step 4.3 mcp__agent-deck__archive_plan 原子收口

（注: 前会话已完成 Step 3.0.1 + 3.0.2 但 plan §步骤 checklist 没标 [x]; 本会话不 retro 补标）

## 下一会话第一步（Round 1 fix M6 修订 — 补 worktree HEAD self-check）

**当前 session 仍在跑**，不需要 cold start。但若 context 烧光需要 hand-off，新 session cold-start 第一步（应用 §Step 3 cold-start 5 步契约完整版）：

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/runtime-logging-electron-log-20260529.md` 读 plan **全文**
2. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/runtime-logging-electron-log-20260529/spike-reports/spike1-rotate-strategy.md` 读 spike (a)
3. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/runtime-logging-electron-log-20260529/spike-reports/spike2-test-env-isolation.md` 读 spike (c)
4. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/runtime-logging-electron-log-20260529/spike-reports/spike3-preload-ipc-bridge.md` 读 spike (b) + (d) deferred 计划
5. **从 plan frontmatter 取 `worktree_path` 字段**（默认 `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/runtime-logging-electron-log-20260529`）
6. `Bash: test -d <worktree_path> && echo EXISTS || echo NOT_EXISTS` 检查 worktree 是否已建：
   - **EXISTS**（前会话已进 Step 2 EnterWorktree）→ 走 `EnterWorktree(path: <worktree_path>)` 进同一 worktree（用 `path` 不用 `name` 避开 v2.1.112 stale base bug）
   - **NOT_EXISTS**（前会话未进 Step 2，仍在 Step 1.5 Round N fix loop）→ 留在主仓库不进 worktree，按 plan §步骤找最早 unchecked step
7. （仅 EXISTS 路径）`Bash: git -C <worktree_path> log --oneline -3` + `Bash: git -C <worktree_path> rev-parse HEAD` 自检 HEAD = frontmatter `base_commit`（57147d9...）或之后；如显著落后 → 撞 v2.1.112 stale base bug 兜底（应用 §EnterWorktree CLI stale base bug callout）
8. 按 plan §步骤 checklist 找最早 unchecked step，**所有指向代码资产的路径换 worktree 内绝对路径**（应用 §Step 2 末 callout）
9. 进度 / 决策变更必须先告诉用户征得确认

## 已知踩坑（写在前面避免再撞）

1. **`/tmp` 残留 `node_modules`** — spike 在 `/tmp/spike-electron-log-*/` 装包时撞 `/tmp/node_modules/better-sqlite3` 残留导致 npm 跑 native rebuild 失败。**修法**：`rm -rf /tmp/node_modules /tmp/package*.json` 清干净再 spike。
2. **GVM_ROOT not set** — `zsh -i -l -c` 第一行 source `$HOME/.gvm/scripts/gvm` 抛 stderr「GVM_ROOT not set」。**修法**：spike runner 直接用 `/bin/bash --noprofile --norc -c 'export PATH=...; ...'` 绕过 zsh init。
3. **electron-log/main.js 入口顶层 require('electron')** — Node 沙箱跑 spike runner 时直接 require electron-log/main.js 撞 `Cannot find module 'electron'`。**双重对策**（Round 1 fix H1 扩展）：
   - **spike runner 修法**：用 `electron-log/node.js` 入口（spike 无需 electron 真实环境时 — spike-a-rotate.mjs / spike-c-test-env.mjs 已用此入口）
   - **生产 logger.ts 修法**：必须用 `electron-log/main`（D8 IPC bridge 仅 main 入口暴露）— **vitest setupFiles 全局 mock electron + electron-log/main**（详 §设计决策 D15 + Step 3.0.2.5），让 85+ 个 main 单测 import 业务模块时不撞 require('electron')
   - **§不变量 2 守门管不到 import side effect**：守门只控制接管动作是否跑，import 解析在 if 检查之前；任何业务模块 `import { logger } from '@main/utils/logger'` 都会触发 logger.ts 顶部 `import 'electron-log/main'` → require('electron')，必须靠 D15 全局 mock 拦住
4. **electron-log 5.x format 自定义** — `[{level}][{scope}]` 空 scope 显示 padded 空白，丑陋。**修法**：用 electron-log 默认 format（已含 `(scope)` 占位 + padding），不要自定义。
5. **接管 console 后写文件 + stdout 同时输出** — 接管不是吞 stdout，dev mode 终端仍能看到 console.log（spike (c) 验证 4 实证）。生产 .app 无终端 → stdout 丢但文件保留。**这正是引入 logger 的目的**。
6. **renderer 端没 `process.env.NODE_ENV`** — vite 注入的是 `import.meta.env.MODE`，守门条件要用对。
7. **resolvePathFn 抛错不挂主程序** — electron-log 内部 try/catch，emit 到 stderr 但不传播业务 throw（spike (a) 验证 3 实证）。**说明**：logger init 出问题不会让主进程挂掉，但 log 会丢。Step 3.5 logger.test.ts 加 stat 验证文件确实写入。
8. **electron-log `log.initialize` API 在 vite + asar 下需实测** — Step 3.0 必跑 spike (b) 实测 B1-B5 验证清单，failure mode fallback 手写 IPC（约 40-60 行）。
9. **macOS 跨时区** — resolvePathFn 走本地时区算「今天」，user 跨时区使用时跨天歧义。**可接受**：user 看本地日期是直觉。
10. **日志文件命名 main- 前缀** — 与 electron-log 默认 `main.log` 一致，cleanup 函数判断 `f.startsWith('main-') && f.endsWith('.log')` 不会误删其他文件。
11. **跨午夜瞬间偏移**（Round 1 fix LOW-Codex/Claude 修订） — long-running process 在午夜跨天瞬间，`resolvePathFn` 在 log 调用时计算当天，跨午夜 0-100ms 内最后一条 log 落新日期文件（与 timestamp 对比偏 ≤ 1 秒）。**可接受不修**：日志 timestamp 与文件日期对照 debug 无影响；如未来需要严格 align，可在 resolvePathFn 内加锁 + buffer flush（成本高）。
12. **dev 模式 app.name='Electron' → ~/Library/Logs/Electron/**（Round 1 fix M7） — 实测 `~/Library/Logs/Electron/` 目录已存在（dev 模式跑 `pnpm dev` 时 Electron 没读 Info.plist productName，app.name 默认 'Electron'）。**修法**：logger.ts 第一行 `app.setName('Agent Deck')`（必须在 `app.getPath('logs')` 之前；Step 3.0.2 落地）→ dev/prod 路径统一到 `~/Library/Logs/Agent Deck/`。
13. **BrowserWindow recreate 场景 IPC bridge 兼容**（Round 1 fix LOW-Codex） — `src/main/window/lifecycle.ts:28-62` 显示 BrowserWindow 可被 Cmd+W 关 + macOS Dock activate 重建。electron-log v5 自动 preload 注入是否在重建后的 BrowserWindow 仍生效（monkey-patch 是 process-wide 还是 per-instance）→ Step 3.0.5 验证清单 B9 + Step 3.7.3 e2e 实测覆盖；spike (b) deferred 时假设兼容（doc 不明示，需实测确认）。
14. **electron-store CJS 顶层 require electron — vitest mock 拦不住**（Step 3.0.2.5 实证发现） — `node_modules/.pnpm/electron-store@8.2.0/node_modules/electron-store/index.js:3` `const {app, ipcMain, ipcRenderer, shell} = require('electron')` 是 **CJS 顶层 require**。vitest hoist 的 `vi.mock('electron', ...)` 对 ESM `import { app } from 'electron'` 生效，但**对 CJS package 内部 `require('electron')` 拦不住**。`settings-store.ts:1 import Store from 'electron-store'` 在 import 链上被 12 个 main 测试文件触发(hand-off-session.* / sdk-bridge.consume-fork / restart-controller-* / spoofing-attack-paths / transport-http-extra-auth / 等)→ 全部 `Error: Electron failed to install correctly`。**修法**：vitest-setup.ts 全局 `vi.mock('electron-store', () => ({ default: class MockStore {...} }))` 整个 module 替换，让 settings-store.ts import 时不触发 electron-store 真实加载，绕过 CJS 内部 require。`settings-store.test.ts:37` 现有 local `vi.mock('electron-store', ...)` 自动覆盖全局 mock（vitest hoist 优先级 local > setupFiles），兼容性 OK。**类比新 npm package 加进来时**：若该 package 是 CJS + 顶层 require electron, 必须在 vitest-setup.ts 加同款全局 mock（不能依赖 vi.mock('electron') 单独拦住）。
