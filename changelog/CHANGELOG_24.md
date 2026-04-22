# CHANGELOG_24: 修 pin 模式下主界面残影

## 概要

pin 模式下窗口背后切换 app / 桌面动画 / 视频播放时，主界面会出现旧画面的"残影"，必须拖一下窗口才会刷新。根因是 macOS transparent 窗口在 vibrancy 关掉之后，CSS `backdrop-filter` 不会跟随下层像素变化重新采样。修复方式：pin 期间主进程定时调用 `webContents.invalidate()` 强制重绘。

## 背景与根因

`window.ts` 的 `setAlwaysOnTop(true)` 做了两件事：
1. 主进程 `setVibrancy(null)` 关掉 macOS 系统级模糊
2. CSS `.frosted-frame[data-pinned='true']` 切到 `rgba(18,18,24,0.2)` 极透明 + `backdrop-filter: blur(18px)`

这两件事单独都没问题，凑在一起触发了 Chromium 的合成层缓存语义：

- macOS 上 Chromium 合成器**只在窗口本身有事件**（移动 / resize / DOM 变化 / 鼠标事件）时才会重新采样窗口下方像素喂给 `backdrop-filter`
- 下层 app 切换时窗口自身一动不动 → 合成器认为不需要重绘 → backdrop-filter 持续展示旧的下方快照 → 残影
- 拖动窗口 → 触发 invalidate → 重新采样 → 残影消失

非 pin 模式下因为 `vibrancy: 'under-window'` 由 macOS 系统层负责持续刷新，不依赖 Chromium 合成器，所以观察不到这个问题。

## 变更内容

### src/main/window.ts
- `FloatingWindow` 新增私有字段 `invalidateTimer: NodeJS.Timeout | null`
- `setAlwaysOnTop(value)` 末尾新增逻辑：先 `stopInvalidateLoop()`，若 `value && darwin` 再 `startInvalidateLoop()`
- 新增 `startInvalidateLoop()`：每 200ms（约 5fps）调一次 `this.win.webContents.invalidate()`，并自带 `isDestroyed` 守卫；窗口已销毁时自动 stop（防止 `floating.close()` 之外的销毁路径漏清理）
- 新增 `stopInvalidateLoop()`：clearInterval + 置 null
- `close()` 在 `this.win?.close()` 前补一次 `stopInvalidateLoop()`，确保进程退出 / activate 重建窗口前定时器一定关掉

## 取舍说明
- **频率选 200ms（5fps）**：实测肉眼无感、GPU 开销可忽略；更高频（50ms）增加无意义合成开销，更低频（500ms）会让用户切窗口时还能瞥到一闪的残影
- **平台 / 状态门控**：只有 darwin + pin 才启动定时器；非 macOS 没有 vibrancy 概念，非 pin 由系统 vibrancy 兜底，都不需要这个机制，避免常驻定时器
- **不改 CSS / 不改 vibrancy**：保留原视觉效果（pin 态绝对通透、不带系统底色）。备选方案 A 是把 `setVibrancy(null)` 换成 `'hud'`，由系统层接管刷新——零开销但会引入浅色基底，与原设计意图冲突，故未采用
- **invalidate 比 setBackgroundColor / setBounds 微调更轻**：前者只触发合成层重绘，不走 layout / paint pipeline，是 Electron 公开 API 里专门为这种场景准备的

## 不在这次改动范围内
- 非 pin 模式的渲染（vibrancy 自带刷新）
- compact 模式 / flash() 动画路径不受影响
- 历史 CHANGELOG_22 的 `safeSend`：那个修的是 webContents.send 撞已销毁窗口；本次是合成器层面的渲染 bug，与窗口生命周期无关
