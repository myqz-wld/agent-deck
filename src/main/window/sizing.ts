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
 */
export function toggleCompactImpl(state: FloatingWindowState): boolean {
  if (!state.win) return state.compact;
  state.compact = !state.compact;
  if (state.compact) {
    const [w, h] = state.win.getSize();
    state.win.setMinimumSize(MIN_WIDTH, COMPACT_HEIGHT);
    state.lastNormalSize = { width: w, height: h };
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
  // R2 MED-2 短路: 跨屏后窗口物理尺寸 == 上次 toggle 设的 lastNormalSize (用户没拖) → 不存
  if (curW === state.lastNormalSize.width && curH === state.lastNormalSize.height) return;
  // R3 LOW (animate race) 短路: macOS setBounds animate=true 期间 getSize 取动画中间帧,
  // 不等于已写终态 lastNormalSize 绕过上面短路。300ms guard 内不存,避免污染 preferredSize。
  if (Date.now() - state.lastToggleAt < ANIMATE_GUARD_MS) return;
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
