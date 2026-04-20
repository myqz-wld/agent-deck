# CHANGELOG_22: 修 webContents.send 撞已销毁窗口

## 概要

`session:delete` IPC 调用、LifecycleScheduler 周期 scan 触发 `markDormant` 时偶发 `TypeError: Object has been destroyed`。根因在 `src/main/index.ts` 第 130-137 行的 `eventBus.on(...)` 闭包：6 条 listener 直接捕获了 bootstrap 阶段创建的 `win` 引用。macOS `window-all-closed` 不退进程（保活）→ 用户关掉窗口后 `BrowserWindow` 已 destroyed，但 listener 依然存在；下一次 scheduler tick / IPC 触发 `eventBus.emit` 调到 `win.webContents.send(...)` 就抛。`activate` 重建窗口时同样的问题：listener 持有的还是旧 win，事件不会投到新窗口。

修法：抽 `safeSend(channel, payload)`，每次发送前用 `floating.window` 动态拿当前活窗口 + `isDestroyed()` / `webContents.isDestroyed()` 兜底；6 条 eventBus listener 全改走它。`globalShortcut` 注册的 pin 切换回调同样改用 floating.window 取窗口，避免重建后操作旧 win。

## 变更内容

### src/main/index.ts
- 删掉 `const win = floating.create()` 的本地引用（不再被任何 listener 捕获）
- 新增 `safeSend<T>(channel, payload)`：通过 `floating.window` getter 取当前 win，三重 destroyed 检查（win 为 null / `win.isDestroyed()` / `win.webContents.isDestroyed()`），任一为真静默 no-op
- `agent-event` / `session-upserted` / `session-removed` / `session-renamed` / `summary-added` / `session-focus-request` 6 条 listener 全改走 safeSend
- pin 快捷键回调用 `floating.window` 临时取窗口 + `isDestroyed` 守卫，再 `safeSend(IpcEvent.PinToggled)`

## 不在这次改动范围内
- BrowserWindow 在 macOS 关闭后是否要顺手 `app.quit()`：保留现有"保活，等 dock activate 重建"的语义不变，仅修触发后未处理的 race
- ensureFocusableOnActivate 重建窗口后的状态恢复（pin / compact 等）—— 当前 floating 单例已经记着 `compact` / `lastNormalSize`，pin 没记；如果以后用户反馈"重新激活后 pin 状态丢了"再单独处理
