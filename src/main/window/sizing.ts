import { BrowserWindow, screen } from 'electron';

import {
  COMPACT_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_INSET,
  TARGET_TOLERANCE_PX,
  ANIMATE_GUARD_MS,
  type DisplayWorkArea,
  type FloatingWindowState,
} from './_deps';

/**
 * 折叠态切换 — `state.compact` true/false toggle。
 *
 * **R2 fix REVIEW_45 MED-1**: 进 compact 前必须临时降 minimumSize,否则 constructor
 * minHeight=MIN_HEIGHT=260 会让 Electron 直接拒 setSize(W, 64) 把窗口卡在 260px;
 * 退 compact 时恢复 normal 底线;clamp lastNormalSize 防 R1 旧路径残留 < MIN_HEIGHT 值。
 *
 * **REVIEW_103 R2 fix (fold-time capture)**: 进 compact 瞬间用真实物理尺寸 (getSize) 判 custom
 * 并存 preferredSize —— 这是唯一能拿到「折叠前用户真实尺寸」的时机 (unfold→toggle 路径只能
 * 派生 lastNormalSize 无法区分 stale,R1/R2 在那里修都按下葫芦起瓢)。custom 判定按**当前屏**
 * max/default,跨屏后折叠正确不记 toggle 尺寸。animate guard 防折叠紧跟 toggle 动画时 getSize
 * 取中间帧污染 (codex R2 *未验证* 项一并收口)。
 */
export function toggleCompactImpl(state: FloatingWindowState): boolean {
  if (!state.win || state.win.isDestroyed()) return state.compact;
  state.compact = !state.compact;
  if (state.compact) {
    const [w, h] = state.win.getSize();
    // REVIEW_103 R2: 折叠瞬间用真实物理尺寸 (w,h) 捕获 custom 偏好 (按当前屏 max/default 判定 +
    // animate guard)。必须放在 lastNormalSize 覆盖之前传入 w/h —— 此刻 getSize() 是折叠前的
    // 真实窗口尺寸,正是要记的「用户偏好」;下面 lastNormalSize 覆盖后就拿不到了。
    // capture 用 state.win.getBounds() 定位当前 display,与 lastNormalSize 无关。
    captureCustomIfApplicable(state, w, h);
    // REVIEW_103 R3 LOW (codex): animate guard 也要护 lastNormalSize —— 折叠紧跟一次
    // toggleMaximize/Default 的 setBounds animate (macOS ~250ms) 时,getSize() 取中间帧,
    // 无条件写进 lastNormalSize 会让展开恢复中间帧 (captureCustomIfApplicable 已护 preferredSize
    // 但 lastNormalSize 是另一条恢复路径)。300ms guard 内不信 getSize,沿用既有 lastNormalSize
    // 作折叠 / 展开目标 (上一次稳定的 normal 尺寸);guard 外才用新读的 w/h。
    if (shouldTrustGetSize(Date.now(), state.lastToggleAt)) {
      state.lastNormalSize = { width: w, height: h };
    }
    state.win.setMinimumSize(MIN_WIDTH, COMPACT_HEIGHT);
    state.win.setSize(state.lastNormalSize.width, COMPACT_HEIGHT, true);
  } else {
    // 退 compact:lastNormalSize.height 可能是 R1 旧路径残留的 < MIN_HEIGHT 值(如用户
    // 在 R1 minHeight=64 期间手动拖到 100px 后折叠保存的 100px),先 clamp 到 MIN_HEIGHT
    // 防展开后仍不可用;setMinimumSize 恢复 normal 底线(必须在 setSize 之前调,否则
    // 旧 minimumSize=COMPACT_HEIGHT 不会反向 enlarge 当前 64px → setSize(_, MIN_HEIGHT)
    // 失败 silent)。
    state.win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
    const restoreW = Math.max(MIN_WIDTH, state.lastNormalSize.width);
    const restoreH = Math.max(MIN_HEIGHT, state.lastNormalSize.height);
    state.win.setSize(restoreW, restoreH, true);
    state.lastNormalSize = { width: restoreW, height: restoreH };
  }
  return state.compact;
}

/**
 * 一键放大到屏幕最大 / toggle 回上次「自定义」尺寸(CHANGELOG_124;R1 fix REVIEW_45 HIGH-1 setSize→setBounds + MED-2 clamp 后 isNear 再判 + MED-1 emit compactToggled)。
 *
 * 行为:
 * - 当前 ≠ max:先 `rememberIfCustom` 记录当前到 preferredSize (仅当当前既非 max 也非 default),
 *   然后 setBounds 居中到屏幕 workArea 最大 (留 40px 边距)
 * - 当前 = max (容差 4px):恢复 preferredSize;preferredSize clamp 后仍撞 max 时回退默认 520×680
 * - compact 态被调用先退出 compact + emit `IpcEvent.CompactToggled` 让 renderer 同步 UI
 *
 * 关键 fix (REVIEW_45 R1):
 * - HIGH-1:setSize 不改位置 → max 后窗口右边界离屏(默认 x 靠右 20px 创建)。
 *   改 `setBounds({x, y, width, height})` + max 时居中到当前所在 display。default 时
 *   保留当前 x/y 但 clamp 到 display 内 (避免 default 也离屏)。
 * - MED-2:preferredSize fallback 必须**先 clamp 再判 isNear(target)**。跨屏 / 分辨率变小后
 *   原 preferredSize > 当前 maxW,朴素 isNear(fb, max)=false 选 fb 但 clamp 后 == max → 死循环。
 *   修法:clamp 后用 `isNear(clampedW, clampedH, maxW, maxH)` 再判一次,撞顶则走 alt (default)。
 * - MED-1:wasCompact 路径 emit `compact-toggled` event 让 renderer 把按钮 label 翻成「折叠」。
 *
 * 与 `toggleDefault` 共享 `preferredSize`:只记录用户「手动拖出来的尺寸」,不让 toggle
 * 自己造成的 default ↔ max 跳变污染记忆字段 (否则会出现「按 + 切 max → 再按 + 回 default
 *  → 再按 - 不动」的死循环)。
 */
export function toggleMaximizeImpl(state: FloatingWindowState): { width: number; height: number } {
  const w = state.win;
  if (!w || w.isDestroyed()) return { width: 0, height: 0 };
  const wasCompact = state.compact;
  if (state.compact) {
    state.compact = false;
    // R2 fix REVIEW_45 MED-1: 退 compact 时恢复 normal 底线 minimumSize (与 toggleCompact 退出路径同模式)
    w.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
    state.emitCompactChanged?.(false);
  }

  const display = screen.getDisplayMatching(w.getBounds()).workArea;
  const maxW = Math.max(MIN_WIDTH, display.width - MAX_INSET);
  const maxH = Math.max(MIN_HEIGHT, display.height - MAX_INSET);
  const defaultW = Math.min(maxW, DEFAULT_WIDTH);
  const defaultH = Math.min(maxH, DEFAULT_HEIGHT);

  const [rawW, rawH] = w.getSize();
  const curW = wasCompact ? state.lastNormalSize.width : rawW;
  const curH = wasCompact ? state.lastNormalSize.height : rawH;
  const atMax = isNear(curW, curH, maxW, maxH);

  let nextW: number;
  let nextH: number;
  if (atMax) {
    // 撞顶保护两层:(1) 朴素 isNear(fb, max) 排掉等于 max 的 fb;(2) clamp 后再 isNear
    // 一次(fb < max 但 fb > 当前屏 maxW 时 clamp 退化为 max,仍要 fallback 到 default)
    const fb = state.preferredSize;
    let fbW: number;
    let fbH: number;
    if (fb && !isNear(fb.width, fb.height, maxW, maxH)) {
      fbW = Math.max(MIN_WIDTH, Math.min(maxW, fb.width));
      fbH = Math.max(MIN_HEIGHT, Math.min(maxH, fb.height));
      if (isNear(fbW, fbH, maxW, maxH)) {
        // clamp 后撞顶 → preferredSize 在当前 display 上等价 max,走 alt fallback (default)
        fbW = defaultW;
        fbH = defaultH;
      }
    } else {
      fbW = defaultW;
      fbH = defaultH;
    }
    nextW = fbW;
    nextH = fbH;
  } else {
    rememberIfCustom(state, curW, curH, maxW, maxH, defaultW, defaultH);
    nextW = maxW;
    nextH = maxH;
  }

  // HIGH-1: setSize 不改位置 → 默认靠右创建的窗口 max 后右边界离屏。改 setBounds 居中。
  // max 时居中到当前所在 display;fallback / 其他时保留当前 x/y 但 clamp 到 display 内。
  const bounds = w.getBounds();
  return applyTargetSize(state, w, display, bounds, maxW, maxH, nextW, nextH);
}

/**
 * 一键回到默认 520×680 / toggle 回上次「自定义」尺寸 (CHANGELOG_124;R1 fix REVIEW_45 同条款)。
 *
 * 与 `toggleMaximize` 共享 `preferredSize` 记忆字段,见该方法 JSDoc。
 */
export function toggleDefaultImpl(state: FloatingWindowState): { width: number; height: number } {
  const w = state.win;
  if (!w || w.isDestroyed()) return { width: 0, height: 0 };
  const wasCompact = state.compact;
  if (state.compact) {
    state.compact = false;
    // R2 fix REVIEW_45 MED-1: 同 toggleMaximize 退 compact 路径
    w.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
    state.emitCompactChanged?.(false);
  }

  const display = screen.getDisplayMatching(w.getBounds()).workArea;
  const maxW = Math.max(MIN_WIDTH, display.width - MAX_INSET);
  const maxH = Math.max(MIN_HEIGHT, display.height - MAX_INSET);
  const defaultW = Math.min(maxW, DEFAULT_WIDTH);
  const defaultH = Math.min(maxH, DEFAULT_HEIGHT);

  const [rawW, rawH] = w.getSize();
  const curW = wasCompact ? state.lastNormalSize.width : rawW;
  const curH = wasCompact ? state.lastNormalSize.height : rawH;
  const atDefault = isNear(curW, curH, defaultW, defaultH);

  let nextW: number;
  let nextH: number;
  if (atDefault) {
    const fb = state.preferredSize;
    let fbW: number;
    let fbH: number;
    if (fb && !isNear(fb.width, fb.height, defaultW, defaultH)) {
      fbW = Math.max(MIN_WIDTH, Math.min(maxW, fb.width));
      fbH = Math.max(MIN_HEIGHT, Math.min(maxH, fb.height));
      if (isNear(fbW, fbH, defaultW, defaultH)) {
        // clamp 后撞 default → preferredSize 在当前 display 上等价 default,走 alt fallback (max)
        fbW = maxW;
        fbH = maxH;
      }
    } else {
      fbW = maxW;
      fbH = maxH;
    }
    nextW = fbW;
    nextH = fbH;
  } else {
    rememberIfCustom(state, curW, curH, maxW, maxH, defaultW, defaultH);
    nextW = defaultW;
    nextH = defaultH;
  }

  const bounds = w.getBounds();
  return applyTargetSize(state, w, display, bounds, maxW, maxH, nextW, nextH);
}

/**
 * R2 fix REVIEW_45 INFO-2 (claude): toggleMaximize / toggleDefault 收尾 9 行重复抽 helper。
 *
 * max 时居中到当前 display;非 max 保留当前 x/y 但 clamp 到 display 内 (防 default
 * toggle 后窗口仍在屏外)。setBounds 用 animate=true 带原生动画。
 */
function applyTargetSize(
  state: FloatingWindowState,
  w: BrowserWindow,
  display: DisplayWorkArea,
  bounds: DisplayWorkArea,
  maxW: number,
  maxH: number,
  nextW: number,
  nextH: number,
): { width: number; height: number } {
  const targetIsMax = nextW === maxW && nextH === maxH;
  const { x, y } = targetIsMax
    ? centerInDisplay(display, nextW, nextH)
    : clampPositionInDisplay(display, bounds.x, bounds.y, nextW, nextH);
  w.setBounds({ x, y, width: nextW, height: nextH }, true);
  state.lastNormalSize = { width: nextW, height: nextH };
  // R3 fix REVIEW_45 LOW (animate race): 记录 toggle 时间戳 → rememberIfCustom 入口
  // 在 ANIMATE_GUARD_MS 内 return 短路,防 macOS setBounds animate 中间帧污染 preferredSize。
  state.lastToggleAt = Date.now();
  return { width: nextW, height: nextH };
}

/**
 * 仅当当前尺寸既非 max 也非 default 时把它存进 preferredSize —— 即「用户手动拖出
 * 来的中间尺寸」。toggle 自身在 max ↔ default 之间跳的尺寸不污染记忆字段。
 *
 * **R2 fix REVIEW_45 MED-2 修法 (a)**: 入口加 lastNormalSize 短路 —— 跨屏后用户没拖,
 * 窗口物理尺寸仍是跨屏前 toggle 设的旧 max/default 值 (Electron 不自动缩窗口),与新屏
 * isNear 判断都 false 走 rememberIfCustom → 旧 toggle 尺寸被当 "custom" 覆写真实偏好。
 * 短路条件:curSize === lastNormalSize → 用户没主动拖过 → 不存。代价:用户精确手动拖回
 * 上次 toggle 同尺寸 (极罕见) 也不被记,可接受。
 *
 * **REVIEW_103 MED-1 / R2 修法 (fold-time capture)**: 旧 compact 路径里 toggleMaximize/
 * toggleDefault 把 curW/curH 派生自 lastNormalSize,无法靠本短路区分「折叠前用户真实尺寸」
 * 与「折叠时正处 toggle 尺寸的 stale」—— R1 用 fromCompact 一刀切关短路修了同屏 MED-1 却
 * 重新打开跨屏污染 (R2 双 reviewer 独立 sim 实证 grow/shrink 都 clobber 真实 preferredSize)。
 * 改为不在 unfold→toggle 路径记 custom:**折叠瞬间** (toggleCompactImpl 进 compact 分支) 直接
 * 用 state.win.getSize() 拿到的**真实物理尺寸**判 custom 并存 (详 toggleCompactImpl)。本函数
 * 因此回到 REVIEW_45 原形 —— wasCompact 路径 caller 传入 curW/curH==lastNormalSize 必短路 no-op,
 * 跨屏污染面彻底关闭。
 *
 * **in-memory only**: 重启应用 preferredSize 清零 (settings.json 不持久化) —— 与
 * windowTransparent / alwaysOnTop 不同的取舍:尺寸偏好通常是"本次会话临时"语义,
 * 长跨度持久化反而误导 (重启场景常对应 display / 工作流变化)。如未来用户报,再走
 * settings 升级。
 */
function rememberIfCustom(
  state: FloatingWindowState,
  curW: number,
  curH: number,
  maxW: number,
  maxH: number,
  defaultW: number,
  defaultH: number,
): void {
  // R2 MED-2 短路: 跨屏后窗口物理尺寸 == 上次 toggle 设的 lastNormalSize (用户没拖) → 不存。
  // wasCompact 路径 caller 传 curW/curH==lastNormalSize 也走此短路 no-op (fold-time capture 已
  // 在折叠瞬间记过真实尺寸,unfold→toggle 不需再记)。
  if (curW === state.lastNormalSize.width && curH === state.lastNormalSize.height) return;
  // R3 LOW (animate race) 短路: macOS setBounds animate=true 期间 getSize 取动画中间帧,
  // 不等于已写终态 lastNormalSize 绕过上面短路。300ms guard 内不存,避免污染 preferredSize。
  if (!shouldTrustGetSize(Date.now(), state.lastToggleAt)) return;
  const atMax = isNear(curW, curH, maxW, maxH);
  const atDefault = isNear(curW, curH, defaultW, defaultH);
  if (!atMax && !atDefault) {
    state.preferredSize = { width: curW, height: curH };
  }
}

/** 容差比较 — 用户拖窗口后尺寸可能与 setSize 时差 1-2px,直接 `===` 会把刚切完窗口误判为「不在目标态」。 */
function isNear(aW: number, aH: number, bW: number, bH: number): boolean {
  return Math.abs(aW - bW) <= TARGET_TOLERANCE_PX && Math.abs(aH - bH) <= TARGET_TOLERANCE_PX;
}

/**
 * getSize() 当前是否可信 (不在 setBounds animate 中间帧窗口内)。
 *
 * macOS setBounds(_, true) 是 ~250ms 异步原生动画,期间 getSize() 取动画中间帧。toggle 时
 * 记 lastToggleAt=now,本函数判 now - lastToggleAt ≥ ANIMATE_GUARD_MS(300ms,留 50ms 余量)。
 * captureCustomIfApplicable (preferredSize 写入) 与 toggleCompactImpl (lastNormalSize 写入)
 * 共用此判定 —— 两条恢复路径都不能信中间帧 (REVIEW_45 R3 LOW + REVIEW_103 R3 LOW codex)。
 * 抽纯函数便于 unit test (REVIEW_103 R3 INFO claude)。
 */
function shouldTrustGetSize(now: number, lastToggleAt: number): boolean {
  return now - lastToggleAt >= ANIMATE_GUARD_MS;
}

/**
 * 折叠瞬间捕获用户真实自定义尺寸到 preferredSize (REVIEW_103 R2 fold-time capture)。
 *
 * 入参 curW/curH 是 toggleCompactImpl 折叠分支 state.win.getSize() 拿到的**真实物理尺寸**
 * (不是派生值),按窗口**当前所在 display** 的 max/default 判 custom:既非 max 也非 default →
 * 是用户手动拖出来的尺寸 → 记。跨屏后折叠时旧屏 toggle 尺寸对新屏可能既非 max 也非 default,
 * 但用户既然「折叠」就意味着这是 ta 当下窗口的真实尺寸,记之合理 (与「unfold→toggle 派生 stale」
 * 本质不同 —— 那里的尺寸是历史残留)。
 *
 * animate guard: 折叠紧跟一次 toggleMaximize/Default 的 setBounds animate (macOS ~250ms) 时,
 * getSize 取动画中间帧 → 300ms guard 内不捕获,避免中间帧污染 (codex R2 *未验证* 项)。
 */
function captureCustomIfApplicable(state: FloatingWindowState, curW: number, curH: number): void {
  if (!state.win) return;
  if (!shouldTrustGetSize(Date.now(), state.lastToggleAt)) return;
  const display = screen.getDisplayMatching(state.win.getBounds()).workArea;
  const maxW = Math.max(MIN_WIDTH, display.width - MAX_INSET);
  const maxH = Math.max(MIN_HEIGHT, display.height - MAX_INSET);
  const defaultW = Math.min(maxW, DEFAULT_WIDTH);
  const defaultH = Math.min(maxH, DEFAULT_HEIGHT);
  if (shouldCaptureCustom(curW, curH, maxW, maxH, defaultW, defaultH)) {
    state.preferredSize = { width: curW, height: curH };
  }
}

/**
 * 折叠捕获的**纯决策**部分 (与 captureCustomIfApplicable 的 screen 查询解耦,便于 unit test):
 * 物理尺寸既非当前屏 max 也非 default → 是用户手动拖出来的 custom → 应捕获。
 */
function shouldCaptureCustom(
  curW: number,
  curH: number,
  maxW: number,
  maxH: number,
  defaultW: number,
  defaultH: number,
): boolean {
  return !isNear(curW, curH, maxW, maxH) && !isNear(curW, curH, defaultW, defaultH);
}

/**
 * 居中到 display workArea;用 floor 防 1px 偏右导致 setBounds round 上越界。
 *
 * R2 fix REVIEW_45 LOW (claude INFO + codex LOW 双方): 极小屏 (display.width < w) 或
 * display.x 为负 (左屏在主屏左侧) 时 center 算式可能输出 < display.x,导致窗口标题区
 * 跑出 workArea 左/上。兜底 Math.max 强制不越上界。
 */
function centerInDisplay(display: DisplayWorkArea, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(display.x, display.x + Math.floor((display.width - w) / 2)),
    y: Math.max(display.y, display.y + Math.floor((display.height - h) / 2)),
  };
}

/**
 * 保留当前 x/y 但 clamp 到 display 内 (防止 default toggle 后窗口仍在屏外)。
 *
 * R2 fix REVIEW_45 LOW: w > display.width 时 maxX < minX,min(maxX, x) 后 max(minX, ...)
 * 会强制走 minX (= display.x),等价 "贴左 + 部分越右"。极小屏 / 窗口比屏宽场景体感正确。
 */
function clampPositionInDisplay(
  display: DisplayWorkArea,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number } {
  const minX = display.x;
  const minY = display.y;
  const maxX = display.x + display.width - w;
  const maxY = display.y + display.height - h;
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    y: Math.max(minY, Math.min(maxY, y)),
  };
}

// ─── test-only exports (REVIEW_103 INFO-1) ───────────────────────────────────
// geometry / remember 纯逻辑零 Electron 依赖,但 file-private 无法被 vitest 直接 import。
// 收敛进单一 __testExports 对象暴露给 __tests__/window-sizing.test.ts,生产代码不引用
// (与公开 toggle* API 物理隔离,避免误用)。锁 REVIEW_45 历史修复点 (负坐标 display /
// 极小屏 clamp / isNear 容差 / animate guard) + REVIEW_103 R2 fold-time capture 决策
// (shouldCaptureCustom 跨屏 custom 判定)。
export const __testExports = {
  isNear,
  shouldTrustGetSize,
  centerInDisplay,
  clampPositionInDisplay,
  rememberIfCustom,
  shouldCaptureCustom,
};
