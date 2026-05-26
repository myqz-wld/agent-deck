# CHANGELOG_11: 主进程稳定性（safeSend + pin 残影治根）

## 概要

合并原 CHANGELOG_22（修 webContents.send 撞已销毁窗口）+ CHANGELOG_24（修 pin 模式残影 - 早期方案）+ CHANGELOG_35（pin 残影根因升级 + 清理 render-mode.ts）。两组主进程稳定性修复：(1) safeSend 守 isDestroyed；(2) pin 残影从「200ms invalidate」（CHANGELOG_24）升级到「`::before mix-blend-mode` 治根 + 100ms invalidate + setBackgroundThrottling(false)」（CHANGELOG_35），中间还有 CHANGELOG_43 追加的 `kickRepaintAfterPin` one-shot 强刷（在 CHANGELOG_14 里）。

## 变更内容

### safeSend 兜底 isDestroyed（原 CHANGELOG_22）

- `session:delete` IPC、LifecycleScheduler 周期 scan 触发 `markDormant` 时偶发 `TypeError: Object has been destroyed`
- 根因：`src/main/index.ts` 第 130-137 行 `eventBus.on(...)` 闭包 6 条 listener 直接捕获了 bootstrap 阶段创建的 `win` 引用。macOS `window-all-closed` 不退进程（保活）→ 用户关掉窗口后 `BrowserWindow` 已 destroyed，但 listener 依然存在；下一次 scheduler tick / IPC 触发 `eventBus.emit` 调到 `win.webContents.send(...)` 就抛
- 修：删掉 `const win = floating.create()` 本地引用；新增 `safeSend<T>(channel, payload)` 通过 `floating.window` getter 取当前 win，三重 destroyed 检查（win 为 null / `win.isDestroyed()` / `win.webContents.isDestroyed()`），任一为真静默 no-op
- `agent-event` / `session-upserted` / `session-removed` / `session-renamed` / `summary-added` / `session-focus-request` 6 条 listener 全改走 safeSend
- pin 快捷键回调用 `floating.window` 临时取窗口 + `isDestroyed` 守卫

### pin 残影早期方案：200ms invalidate（原 CHANGELOG_24，已被 CHANGELOG_35 升级）

- pin 模式下窗口背后切换 app / 桌面动画 / 视频播放时主界面出现旧画面残影，必须拖一下窗口才会刷新
- 早期理解：macOS transparent 窗口 vibrancy 关掉之后，CSS `backdrop-filter` 不会跟随下层像素变化重新采样
- `FloatingWindow` 新增私有字段 `invalidateTimer`；`setAlwaysOnTop(value)` 末尾若 `value && darwin` → `startInvalidateLoop()`：每 200ms 调一次 `webContents.invalidate()`
- 后被 CHANGELOG_35 升级（见下）—— 200ms (5fps) 在动态场景下肉眼能瞥到旧帧，根因也不准

### pin 残影根因升级（原 CHANGELOG_35，**当前生效方案**）

CHANGELOG_24 的 5fps invalidate 在动态场景（滚动 / 视频 / 切下层 app）下肉眼能瞥到旧帧 → 用户实测仍有"文字残影"。**对抗 Agent 双向核实**后定位到两个根因：

1. **CSS 真凶**（CHANGELOG_24 完全没看到）：`.frosted-frame::before` 用 `mix-blend-mode: overlay` 配合父层 `isolation: isolate` + `backdrop-filter`，强制 Chromium 把文字层与噪点合成进 offscreen group surface，**该 group surface 被 Blink 缓存，`webContents.invalidate()` 不能让它失效** → 文字"印"在玻璃上，与下方动态画面错位
2. **频率 + 节流**：5fps 太低；窗口失焦时 Chromium 默认对 webContents 做 paint 节流，invalidate 实际频率被压到 1-2fps

修复：

- `globals.css`：`.frosted-frame[data-pinned='true']::before { display: none }` —— pin 态隐藏噪点 ::before（pin 态 0.2 alpha 本来就几乎看不到噪点，display:none 视觉无回退），根治三件套 group surface 缓存
- `window.ts`：
  - `create()` 末尾加 `webContents.setBackgroundThrottling(false)` 永久关闭节流
  - `startInvalidateLoop` 频率 200ms (5fps) → 100ms (10fps)
  - `setAlwaysOnTop` 注释完整重写：删掉 CHANGELOG_24 那段「关掉 vibrancy 后窗口仅靠 CSS backdrop-filter 提供模糊」的错误认知；改为正确的根因说明（invalidate 触发 NSWindow 重新与桌面合成顺便取下层 app 最新像素，频率即下层桌面感知 fps）

### 顺手清理 `render-mode.ts` 死代码（原 CHANGELOG_35）

- CHANGELOG_3 把 MD/TXT 切换从「全局共享」改成「每条独立」之后，localStorage 的 `agent-deck:message-render-mode` 键再没人写了，`readInitialRenderMode()` 等价于 `() => 'plaintext'`，整个文件就是死代码
- `src/renderer/lib/render-mode.ts`：整文件删除
- `ActivityFeed.tsx`：删 `import { readInitialRenderMode, type RenderMode }`；inline `type RenderMode = 'plaintext' | 'markdown'` + `const DEFAULT_RENDER_MODE: RenderMode = 'plaintext'`；`MessageBubble useState` 初始化从 `() => readInitialRenderMode()` 改为常量

## 备注

- BrowserWindow 在 macOS 关闭后是否要顺手 `app.quit()`：保留现有"保活，等 dock activate 重建"的语义不变
- CHANGELOG_24 是 CHANGELOG_35 的早期方案，根因不准但保留 `invalidateTimer` 基础设施给 CHANGELOG_35 沿用；不删 200ms loop 这层的 changelog 历史保留对推演有价值
- 不去掉 `> *:not(.absolute):not(.fixed) { z-index: 1 }`：CLAUDE.md 自家约定明确说"这条不要去掉"
- 不重新审视 `setVibrancy('hud')`：CHANGELOG_24 否决理由（引入浅色基底，与 pin 极透设计冲突）现在仍成立
- 后续 CHANGELOG_14 又追加 `kickRepaintAfterPin()` one-shot 强刷修「进入 pin 那一瞬间的旧帧残影」（CHANGELOG_43）
