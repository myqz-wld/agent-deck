import type { FloatingWindowState } from './_deps';

/** mouse event pass-through 切换 — true = 鼠标点击穿透到下层 app (forward 仍透鼠标 hover 给 web)。 */
export function setIgnoreMouseImpl(state: FloatingWindowState, ignore: boolean): void {
  state.win?.setIgnoreMouseEvents(ignore, { forward: true });
}

/**
 * 窗口短促置顶动画 — macOS 没有任务栏闪烁的标准 API,此处先实现窗口 opacity 闪烁作为视觉提示。
 *
 * **REVIEW_61 LOW-1 (claude) fix**: flash 重入保护。第二次调用必先 clearInterval 旧 timer +
 * setOpacity(savedOriginal) 复位 baseline,再起新轮。避免「A 进行中 setOpacity(0.5) → B 进入
 * getOpacity() 取到 0.5 当 baseline → B 结束 setOpacity(0.5) 永久半透明」。
 *
 * **REVIEW_61 R2 LOW (codex) fix**: capture generation,setInterval cb 跨 close+recreate
 * 不污染新 winB opacity ('closed' listener 已加 clearInterval flashTimer 兜底,这里 generation
 * guard 是双保险:如有 close → recreate 极快导致 'closed' clearInterval 与新 setInterval 注册
 * 时序错开的极端边界,仍能 skip 不操作新 winB)。
 */
export function flashImpl(state: FloatingWindowState): void {
  if (!state.win || state.win.isDestroyed()) return;
  // 重入: 旧 timer 仍在 → 先 clear + 复位 opacity 再起新轮 (保 savedOriginal 一致性)
  if (state.flashTimer) {
    clearInterval(state.flashTimer);
    state.flashTimer = null;
    state.win.setOpacity(state.flashOriginalOpacity);
  }
  const capturedWin = state.win;
  state.flashOriginalOpacity = capturedWin.getOpacity();
  let count = 0;
  state.flashTimer = setInterval(() => {
    // generation guard: state.win 已切到 winB / capturedWin 已 destroyed → 退出不复位 opacity
    // (复位是为本 generation 自己 baseline,跨 generation 复位会污染 winB 真实 opacity)
    if (state.win !== capturedWin || capturedWin.isDestroyed() || count >= 6) {
      if (state.win === capturedWin && !capturedWin.isDestroyed()) {
        capturedWin.setOpacity(state.flashOriginalOpacity);
      }
      if (state.flashTimer) clearInterval(state.flashTimer);
      state.flashTimer = null;
      return;
    }
    capturedWin.setOpacity(count % 2 === 0 ? 0.5 : state.flashOriginalOpacity);
    count += 1;
  }, 120);
}
