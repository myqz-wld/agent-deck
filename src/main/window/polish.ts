import type { FloatingWindowState } from './_deps';

/** mouse event pass-through 切换 — true = 鼠标点击穿透到下层 app (forward 仍透鼠标 hover 给 web)。 */
export function setIgnoreMouseImpl(state: FloatingWindowState, ignore: boolean): void {
  // REVIEW_103 L-E: 与其他 impl 一致守 isDestroyed (destroyed-nonnull window 调
  // setIgnoreMouseEvents 会 throw);当前 'closed' listener 同步置 state.win=null 使其几乎不可达,
  // 此处零成本一致性防御。
  if (!state.win || state.win.isDestroyed()) return;
  state.win.setIgnoreMouseEvents(ignore, { forward: true });
}

/**
 * 窗口短促置顶动画 — macOS 没有任务栏闪烁的标准 API,此处先实现窗口 opacity 闪烁作为视觉提示。
 *
 * **⚠️ 当前无生产调用点 (REVIEW_103 D-1)**: notify/visual.ts 已删 flash 调用 (CHANGELOG_4「去
 * 闪屏」),但 `FloatingWindow.flash()` 方法 **CHANGELOG_4 明确「留着不删,备未来主动呼叫高优场景」**
 * —— 是有意保留的待接线特性 (documented intentional),不是误留死代码,故 **不删**。无对应 IPC
 * channel,接线时需补 IpcInvoke + preload + renderer。下方 REVIEW_45/61 重入 + generation guard
 * 加固作用在该「待用」方法上,接线即可用。
 *
 * **REVIEW_61 LOW-1 (claude) fix**: flash 重入保护。第二次调用必先 clearInterval 旧 timer +
 * setOpacity(savedOriginal) 复位 baseline,再起新轮。避免「A 进行中 setOpacity(0.5) → B 进入
 * getOpacity() 取到 0.5 当 baseline → B 结束 setOpacity(0.5) 永久半透明」。
 *
 * **REVIEW_61 R2 LOW (codex) fix**: capture generation,setInterval cb 跨 close+recreate
 * 不污染新 winB opacity ('closed' listener 已加 clearInterval flashTimer 兜底,这里 generation
 * guard 是双保险:如有 close → recreate 极快导致 'closed' clearInterval 与新 setInterval 注册
 * 时序错开的极端边界,仍能 skip 不操作新 winB)。
 *
 * **REVIEW_103 L-D fix**: 捕获本轮 interval handle,退出分支只 clear 自己这轮 (interval),不无脑
 * clear `state.flashTimer` slot —— 否则旧轮 cb 跨 recreate 到点会清掉已被新轮覆盖的 slot 句柄。
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
  const interval = setInterval(() => {
    // generation guard: state.win 已切到 winB / capturedWin 已 destroyed → 退出不复位 opacity
    // (复位是为本 generation 自己 baseline,跨 generation 复位会污染 winB 真实 opacity)
    if (state.win !== capturedWin || capturedWin.isDestroyed() || count >= 6) {
      if (state.win === capturedWin && !capturedWin.isDestroyed()) {
        capturedWin.setOpacity(state.flashOriginalOpacity);
      }
      clearInterval(interval);
      // L-D: 只在 slot 仍指向本轮 interval 时清,避免误清新轮句柄
      if (state.flashTimer === interval) state.flashTimer = null;
      return;
    }
    capturedWin.setOpacity(count % 2 === 0 ? 0.5 : state.flashOriginalOpacity);
    count += 1;
  }, 120);
  state.flashTimer = interval;
}
