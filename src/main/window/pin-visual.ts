import type { FloatingWindowState } from './_deps';

/**
 * pin 模式切换 + vibrancy / invalidate loop 联动。
 *
 * **vibrancy 决策** (Phase 5 Step 5.6 plan mcp-bug-and-feature-batch-20260513):
 * 透明 / 置顶解耦后 vibrancy 仅由 `state.windowTransparent` 决定,不再 && alwaysOnTop。
 * 四种组合都合法 — pin + 透明 / pin + 不透明 / 不 pin + 透明 / 不 pin + 不透明。
 *
 * **invalidate loop 启动决策** (CHANGELOG_24/35):
 * 只在 `pin + macOS` 时启 100ms 循环触发 `webContents.invalidate()` 让 NSWindow 与桌面
 * 重新合成,顺带把下层 app 最新像素拿进来。
 *
 * **注意**: CHANGELOG_24 当时的认知有误——这里**不是** "CSS backdrop-filter 在模糊下层 app
 * 像素"。pin 态下 backdrop-filter 模糊的是窗口自身 layer 的内容（基本是空的）,下层 app 的
 * 像素是 NSWindow 在 surface 提交后做的 source-over 合成,根本没经过 blur。invalidate 的
 * 真实作用:触发 Chromium 提交一帧 surface → NSWindow 顺带与桌面背景重新合成 → 顺便取下层
 * app 最新像素。所以**这个频率 = 下层桌面感知 fps**,5fps 的 CHANGELOG_24 设置在动态场景
 * (滚动 / 视频 / 切 app)下肉眼能瞥到旧帧 —— 用户实测有"残影"。
 *
 * CHANGELOG_35 调整:
 * - 200ms (5fps) → 100ms (10fps):动态场景几乎察觉不到延迟,GPU 开销仍可忽略
 * - 配合 webContents.setBackgroundThrottling(false) (create 时一次性调) 确保
 *   invalidate 在窗口失焦时不被压制
 * - 文字残影的另一个根因(::before mix-blend-mode 的 group surface 缓存)
 *   在 globals.css 端通过 pin 态 display:none ::before 治根了
 *
 * 非 macOS / 非 pin 不需要这个机制:vibrancy 由系统层持续刷新。
 */
export function setAlwaysOnTopImpl(state: FloatingWindowState, value: boolean): void {
  // REVIEW_103 R2 LOW: 写入 pin SSOT,让 dock-activate 重建路径 createImpl 能 reconcile。
  state.alwaysOnTop = value;
  if (!state.win || state.win.isDestroyed()) return;
  state.win.setAlwaysOnTop(value, value ? 'floating' : 'normal');
  if (process.platform === 'darwin') {
    state.win.setVibrancy(state.windowTransparent ? null : 'under-window');
  }
  stopInvalidateLoop(state);
  if (value && process.platform === 'darwin') {
    kickRepaintAfterPin(state);
    startInvalidateLoop(state);
  }
}

/**
 * 用户在设置里 / 快捷键切「窗口透明」开关时调;立即重新应用 vibrancy (不依赖 pin 状态)。
 *
 * Phase 5 Step 5.6 (plan mcp-bug-and-feature-batch-20260513):从原 setTransparentWhenPinned
 * 重命名 + 解耦 alwaysOnTop。透明独立于 pin —— 不 pin 也能切换透明视觉,让用户选择。
 */
export function setWindowTransparentImpl(state: FloatingWindowState, value: boolean): void {
  state.windowTransparent = value;
  if (!state.win || state.win.isDestroyed() || process.platform !== 'darwin') return;
  // 解耦后无论 pin 不 pin 都立即应用 vibrancy 切换。startInvalidateLoop 是 pin 时启的
  // 100ms 重绘循环,与透明切换正交(不需在此动)。
  state.win.setVibrancy(value ? null : 'under-window');
}

/**
 * CHANGELOG_35 之后仍有用户反馈:进入 pin 模式那一瞬间的旧帧(含全量文字)会"印"
 * 在玻璃上,必须人工拖一下窗口大小才消失。根因:
 * - vibrancy 切到 null 是异步生效,前几帧 macOS 系统材质还没真关;
 * - 进入 pin 瞬间的 native surface / Chromium compositor 合成层缓存,单靠
 *   webContents.invalidate() 冲不掉(即使 100ms loop 已开也没用);
 * - 拖动窗口 = 触发完整 ViewSizeChanged → relayout/repaint → 旧 surface 必被替换。
 * 解法:模拟一次 resize —— 同步 setContentSize(+1px),下一个 macro task 调回原值,
 * 触发 Chromium 完整 layout/repaint 路径把旧 surface 冲干净。两次调用跨 macro task
 * 防止 Chromium size 去重合并,1px 高度变化在 setImmediate 一个 runloop 内完成,
 * 肉眼难察。
 */
export function kickRepaintAfterPin(state: FloatingWindowState): void {
  const w = state.win;
  if (!w || w.isDestroyed()) return;
  // REVIEW_103 L-C fix: 固定 capturedWin,与 lifecycle.ts createImpl 的 generation guard 同款
  // 不变量 —— 同步段拿 winA content size,若 winA 进 pin 后立刻 close + dock activate 建 winB,
  // setImmediate 回调重读 state.win 会拿到 winB 把它 size 改成 winA 旧尺寸。改用 capturedWin
  // 比对 (state.win === capturedWin) 守门,保留旧 width/height (by design) 但目标 window 固定。
  const capturedWin = w;
  const [width, height] = capturedWin.getContentSize();
  capturedWin.setContentSize(width, height + 1);
  setImmediate(() => {
    if (state.win !== capturedWin || capturedWin.isDestroyed()) return;
    capturedWin.setContentSize(width, height);
  });
}

/** pin + macOS 100ms invalidate loop 启动 — 已启时幂等 noop。 */
export function startInvalidateLoop(state: FloatingWindowState): void {
  if (state.invalidateTimer) return;
  state.invalidateTimer = setInterval(() => {
    const w = state.win;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) {
      stopInvalidateLoop(state);
      return;
    }
    w.webContents.invalidate();
  }, 100);
}

/** 清 invalidate loop timer — pin 解除 / close / 'closed' listener 都调。 */
export function stopInvalidateLoop(state: FloatingWindowState): void {
  if (state.invalidateTimer) {
    clearInterval(state.invalidateTimer);
    state.invalidateTimer = null;
  }
}
