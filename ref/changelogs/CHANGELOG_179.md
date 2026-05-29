# CHANGELOG_179 — plan runtime-logging-electron-log-20260529 §Step 3.2.6 follow-up: preload fatal error 落盘 (方案 2+4 组合)

## 概要

[plan `runtime-logging-electron-log-20260529`](../plans/runtime-logging-electron-log-20260529.md) §Step 3.2.6 follow-up 收尾 — preload script 端 `contextBridge.exposeInMainWorld('api', api)` 失败 / preload script 本身加载失败的 fatal error 现在能在生产 .app 双击启动场景落盘到 `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log`，闭环 plan §不变量 1（生产 .app 必须能落盘）的最后一处边角。

**继承自** plan archive 时按 §Step 3.2.6 spec「依赖 spike (d) 选定方案」一刀切跳过为 follow-up。user 反问后重新分析 plan §Step 3.0.7 4 方案的 dev verify 依赖性，发现**方案 2 + 方案 4 组合不依赖 dev verify**就能稳健落地（全 Electron 标准 API 不依赖 electron-log internal API），是 spike (d) 后最稳的兜底选择。一刀切跳过欠考虑。

**净改动**：4 文件 +55/-4 = +51 LOC。

## 改动内容

### 方案 2 — typed IPC channel + preload 上报

- `src/shared/ipc-channels.ts`：加 `IpcInvoke.PreloadFatalError = 'preload:fatal-error'` channel 常量 + jsdoc 说明 fire-and-forget pattern（`ipcRenderer.send` + `ipcMain.on`，不需 ack；payload `{ message: string; stack?: string }`）
- `src/preload/index.ts`：catch block 改 `console.error(e)` → `ipcRenderer.send(IpcInvoke.PreloadFatalError, { message, stack })`：
  - 顶部 import 加 `ipcRenderer` + `IpcInvoke`
  - `ipcRenderer.send` 失败时 fallback `console.error(e)`（与原行为对齐保 dev 模式 stdout 可见性；生产 .app 仍 silent — 但 preload 内 ipcRenderer 永远 available，fallback 极罕见）
- `src/main/ipc/logs.ts`：新增 PreloadFatalError listener（与现有 3 个 LogsSection invoke handler 同文件）：
  - import `ipcMain`
  - `registerLogsIpc` 末尾加 `ipcMain.on(IpcInvoke.PreloadFatalError, (_event, payload) => log.scope('preload-fatal').error('contextBridge.exposeInMainWorld failed: ...'))`
  - 用 `ipcMain.on` 而非 `invoke/handle`（fire-and-forget 语义）

### 方案 4 — webContents preload-error listener

- `src/main/window/lifecycle.ts`：在现有 `webContents.on('did-fail-load', ...)` 后加 `webContents.on('preload-error', (_event, preloadPath, error) => log.scope('preload-fatal').error(...))`
  - preload script 本身加载失败（语法错 / asar 路径错 / require 失败）兜底
  - 与方案 2 互补：preload-error 拦加载失败 / PreloadFatalError 拦加载成功后内部 throw
  - 两者都落 `'preload-fatal'` scope 便于 grep 排查

## 不变量守约

- ✅ **plan §不变量 1 闭环** — preload 端两类 fatal failure（contextBridge throw + preload script load fail）现在都能在生产 .app 无终端场景落盘
- ✅ **全 Electron 标准 API** — `ipcRenderer.send` / `ipcMain.on` / `webContents.on('preload-error')` 全是 Electron 文档化 API，不依赖 electron-log internal (`__ELECTRON_LOG__` channel) 未文档化路径
- ✅ **不依赖 spike (d) dev verify** — 方案 2+4 组合本身就是 spike (d) 后最稳的兜底选择
- ✅ **vitest 0 fail / 1003 pass / 159 skip 维持**
- ✅ **typecheck + build 双过** — main 715.81 kB / preload 21.63 kB / renderer 1427.72 kB
- ✅ **logger-check 通过** — `src/preload/` 在 grep CI exclude 范围（`--glob '!src/preload/**'`），本改动不影响 0 console.X 残留检查

## 验证

- `pnpm install` 装 electron-log + `electron-builder install-app-deps` 重建 better-sqlite3 binding（与项目踩坑清单同款 ABI 切换路径，正常完成）
- `pnpm typecheck` PASS
- `pnpm exec vitest run` 0 fail / 1003 pass / 159 skip
- `pnpm build` PASS（3 chunks 全 built）
- `bash scripts/logger-check.sh` ✅ 通过

## 后续

- **GUI verify**：user 跑 `pnpm dev` 故意改坏 contextBridge 触发 catch / 改坏 preload script require 触发 preload-error，看 `~/Library/Logs/Agent Deck/main-*.log` 是否落 `preload-fatal` scope 行（类似 plan §Step 3.0.7 spike (d) 实测，但本 commit 落地后 verify 不阻塞）
- **方案 1 + 3 未启用**：方案 1（`electronLog.sendToMain` helper）依赖未文档化 internal API + 方案 3（`webContents.on('console-message')`）与 D5 console capture 接管重叠双倍落盘风险，本次走 2+4 稳健组合不引入额外风险
