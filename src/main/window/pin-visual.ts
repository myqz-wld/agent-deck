import type { FloatingWindowState } from './_deps';

/**
 * pin / 透明模式切换 + vibrancy / invalidate loop 联动。
 *
 * **vibrancy 决策** (Phase 5 Step 5.6 plan mcp-bug-and-feature-batch-20260513):
 * 透明 / 置顶解耦后 vibrancy 仅由 `state.windowTransparent` 决定,不再 && alwaysOnTop。
 * 四种组合都合法 — pin + 透明 / pin + 不透明 / 不 pin + 透明 / 不 pin + 不透明。
 *
 * **invalidate loop 启动决策** (CHANGELOG_24/35 + transparent/pin 解耦修复):
 * 在 macOS 的 `pin || transparent` 状态启 100ms 循环触发 `webContents.invalidate()`，
 * 作为 native surface 活性兜底。透明模式从 pin 解耦后，loop 也必须跟随透明状态，不能
 * 只跟随 pin。
 *
 * **注意**: `invalidate()` 不是滚动残影的根治。它能要求 Chromium 重绘，但不会重建 macOS
 * transparent NSWindow 的完整 surface；若 renderer 根节点带 backdrop-filter，滚动内容会
 * 位于独立 filter render pass 中，旧 native surface 仍可能持续显示，只有 resize 才清掉。
 * globals.css 的透明态因此直接禁用 backdrop-filter，让滚动层通过普通 alpha surface 提交。
 *
 * CHANGELOG_35 调整:
 * - 200ms (5fps) → 100ms (10fps):动态场景几乎察觉不到延迟,GPU 开销仍可忽略
 * - 配合 webContents.setBackgroundThrottling(false) (create 时一次性调) 确保
 *   invalidate 在窗口失焦时不被压制
 * - 透明态隐藏 ::before 噪点并禁用 backdrop-filter，避免额外的离屏 compositor surface
 *
 * 非 macOS，或 `不 pin + 不透明`，不需要这个机制：vibrancy 由系统层持续刷新。
 */
export function setAlwaysOnTopImpl(state: FloatingWindowState, value: boolean): void {
  const changed = state.alwaysOnTop !== value;
  // REVIEW_103 R2 LOW: 写入 pin SSOT,让 dock-activate 重建路径 createImpl 能 reconcile。
  state.alwaysOnTop = value;
  if (!state.win || state.win.isDestroyed()) return;
  state.win.setAlwaysOnTop(value, value ? 'floating' : 'normal');
  if (process.platform === 'darwin') {
    state.win.setVibrancy(state.windowTransparent ? null : 'under-window');
  }
  if (
    changed &&
    process.platform === 'darwin' &&
    (state.alwaysOnTop || state.windowTransparent)
  ) {
    kickCompositorRepaint(state);
  }
  reconcileInvalidateLoop(state);
}

/**
 * 用户在设置里 / 快捷键切「窗口透明」开关时调;立即重新应用 vibrancy (不依赖 pin 状态)。
 *
 * Phase 5 Step 5.6 (plan mcp-bug-and-feature-batch-20260513):从原 setTransparentWhenPinned
 * 重命名 + 解耦 alwaysOnTop。透明独立于 pin —— 不 pin 也能切换透明视觉,让用户选择。
 */
export function setWindowTransparentImpl(state: FloatingWindowState, value: boolean): void {
  const changed = state.windowTransparent !== value;
  state.windowTransparent = value;
  if (!state.win || state.win.isDestroyed() || process.platform !== 'darwin') return;
  state.win.setVibrancy(value ? null : 'under-window');
  if (changed) kickCompositorRepaint(state);
  reconcileInvalidateLoop(state);
}

/**
 * CHANGELOG_35 之后仍有用户反馈:切入 pin / 透明合成状态时的旧帧(含全量文字)会"印"
 * 在玻璃上,必须人工拖一下窗口大小才消失。根因:
 * - vibrancy 切到 null 是异步生效,前几帧 macOS 系统材质还没真关;
 * - 状态切换瞬间的 native surface / Chromium compositor 合成层缓存,单靠
 *   webContents.invalidate() 冲不掉(即使 100ms loop 已开也没用);
 * - 拖动窗口 = 触发完整 ViewSizeChanged → relayout/repaint → 旧 surface 必被替换。
 * 解法:模拟一次 resize —— 同步 setContentSize(+1px),下一个 macro task 调回原值,
 * 触发 Chromium 完整 layout/repaint 路径把旧 surface 冲干净。两次调用跨 macro task
 * 防止 Chromium size 去重合并,1px 高度变化在 setImmediate 一个 runloop 内完成,
 * 肉眼难察。
 */
export function kickCompositorRepaint(state: FloatingWindowState): void {
  const w = state.win;
  if (!w || w.isDestroyed()) return;
  // REVIEW_103 L-C fix: 固定 capturedWin,与 lifecycle.ts createImpl 的 generation guard 同款
  // 不变量 —— 同步段拿 winA content size,若 winA 切换视觉状态后立刻 close + dock activate 建 winB,
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

/** macOS pin/透明态 100ms invalidate loop 启动 — 已启时幂等 noop。 */
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

/** 按当前 pin/透明状态启动或停止持续重绘。 */
function reconcileInvalidateLoop(state: FloatingWindowState): void {
  if (
    process.platform === 'darwin' &&
    (state.alwaysOnTop || state.windowTransparent)
  ) {
    startInvalidateLoop(state);
  } else {
    stopInvalidateLoop(state);
  }
}

/** 清 invalidate loop timer — 离开 pin/透明态、close、'closed' listener 都调。 */
export function stopInvalidateLoop(state: FloatingWindowState): void {
  if (state.invalidateTimer) {
    clearInterval(state.invalidateTimer);
    state.invalidateTimer = null;
  }
}
