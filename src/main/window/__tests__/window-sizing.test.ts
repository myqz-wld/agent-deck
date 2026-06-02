// ─────────────────────────────────────────────────────────────────────────────
// REVIEW_103 INFO-1 — window/sizing.ts geometry / rememberIfCustom 纯逻辑回归锁
//
// 这组纯函数承载 REVIEW_45 多次踩坑历史 (负坐标 display / 极小屏 clamp / isNear 容差 /
// animate guard) + REVIEW_103 R2 fold-time capture 决策 (shouldCaptureCustom)。Round 1 之前
// 0 覆盖,本测试是 deep-review Batch 5 收口产物。纯几何无 Electron 依赖,node env 直跑。
//
// 通过 sizing.ts `__testExports` 拿 file-private helper (生产代码不引用 __testExports)。
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';

import { __testExports } from '@main/window/sizing';
import type { FloatingWindowState } from '@main/window/_deps';

const { isNear, centerInDisplay, clampPositionInDisplay, rememberIfCustom, shouldCaptureCustom } = __testExports;

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 680;

function makeState(over: Partial<FloatingWindowState> = {}): FloatingWindowState {
  return {
    win: null,
    compact: false,
    invalidateTimer: null,
    lastNormalSize: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
    preferredSize: null,
    lastToggleAt: 0,
    windowTransparent: true,
    alwaysOnTop: true,
    flashTimer: null,
    flashOriginalOpacity: 1,
    fallbackShowTimer: null,
    emitCompactChanged: null,
    ...over,
  };
}

describe('window/sizing isNear (TARGET_TOLERANCE_PX=4)', () => {
  it('treats diff ≤ 4px as equal (用户拖窗 1-2px round 误差)', () => {
    expect(isNear(520, 680, 524, 680)).toBe(true); // diff 4 → near
    expect(isNear(520, 680, 520, 684)).toBe(true);
  });
  it('treats diff ≥ 5px as different', () => {
    expect(isNear(520, 680, 525, 680)).toBe(false);
    expect(isNear(520, 680, 520, 685)).toBe(false);
  });
});

describe('window/sizing centerInDisplay', () => {
  it('centers within a normal display', () => {
    const d = { x: 0, y: 0, width: 1920, height: 1080 };
    // max size = display - 40 inset = 1880x1040 → center ~20,20
    expect(centerInDisplay(d, 1880, 1040)).toEqual({ x: 20, y: 20 });
  });

  it('REVIEW_45 LOW: window WIDER than display → Math.max floors to display origin, never negative', () => {
    const d = { x: 0, y: 0, width: 300, height: 300 };
    // (300-520)/2 = -110 → Math.max(0, 0+(-110)) = 0
    expect(centerInDisplay(d, 520, 680)).toEqual({ x: 0, y: 0 });
  });

  it('REVIEW_45 LOW: negative-x (left) monitor keeps window on that monitor', () => {
    const d = { x: -1920, y: 0, width: 1920, height: 1080 };
    const r = centerInDisplay(d, 1880, 1040);
    expect(r.x).toBe(-1900); // -1920 + floor((1920-1880)/2)=20 → -1900
    expect(r.y).toBe(20);
    expect(r.x).toBeGreaterThanOrEqual(d.x); // never escapes left edge
  });
});

describe('window/sizing clampPositionInDisplay', () => {
  const d = { x: 0, y: 0, width: 1920, height: 1080 };
  it('clamps window off the right edge back inside', () => {
    expect(clampPositionInDisplay(d, 5000, 100, 520, 680)).toEqual({ x: 1400, y: 100 }); // 1920-520
  });
  it('clamps window off the left/top back to origin', () => {
    expect(clampPositionInDisplay(d, -500, -500, 520, 680)).toEqual({ x: 0, y: 0 });
  });
  it('REVIEW_45 LOW: window wider than display (maxX<minX) pins to left edge', () => {
    // maxX = 1920-2000 = -80 < minX=0 → Math.min(-80, x) then Math.max(0, ...) = 0
    expect(clampPositionInDisplay(d, 100, 100, 2000, 680).x).toBe(0);
  });
});

describe('window/sizing rememberIfCustom (REVIEW_45 MED-2, reverted to original in REVIEW_103 R2)', () => {
  const maxW = 1880;
  const maxH = 1040;
  const defW = 520;
  const defH = 680;

  it('records a genuinely custom (dragged) size on the direct (non-compact) toggle path', () => {
    const s = makeState({ lastNormalSize: { width: 999, height: 999 } });
    rememberIfCustom(s, 700, 500, maxW, maxH, defW, defH);
    expect(s.preferredSize).toEqual({ width: 700, height: 500 });
  });

  it('REVIEW_45 MED-2: skips when physical size == lastNormalSize (cross-display, user did not drag)', () => {
    const s = makeState({ lastNormalSize: { width: 700, height: 500 } });
    rememberIfCustom(s, 700, 500, maxW, maxH, defW, defH);
    expect(s.preferredSize).toBeNull();
  });

  it('does NOT record when current == max or == default (toggle-induced, not custom)', () => {
    const s1 = makeState({ lastNormalSize: { width: 1, height: 1 } });
    rememberIfCustom(s1, maxW, maxH, maxW, maxH, defW, defH);
    expect(s1.preferredSize).toBeNull(); // atMax
    const s2 = makeState({ lastNormalSize: { width: 1, height: 1 } });
    rememberIfCustom(s2, defW, defH, maxW, maxH, defW, defH);
    expect(s2.preferredSize).toBeNull(); // atDefault
  });

  it('REVIEW_103 R2: wasCompact path passes curW/curH == lastNormalSize → short-circuits to no-op (cross-display safe)', () => {
    // toggleMaximize/toggleDefault wasCompact 分支 caller 传 curW/curH = lastNormalSize → 必短路。
    // 这是 R2 关闭跨屏污染的关键:unfold→toggle 路径不再记 custom,改由 fold-time capture 负责。
    const s = makeState({ lastNormalSize: { width: 1880, height: 1040 } });
    rememberIfCustom(s, 1880, 1040, maxW, maxH, defW, defH); // even cross-display stale → short-circuit
    expect(s.preferredSize).toBeNull();
  });

  it('REVIEW_45 R3 LOW (animate race): skips while within ANIMATE_GUARD_MS of last toggle', () => {
    const s = makeState({ lastNormalSize: { width: 1, height: 1 }, lastToggleAt: Date.now() });
    rememberIfCustom(s, 700, 500, maxW, maxH, defW, defH);
    expect(s.preferredSize).toBeNull();
  });
});

describe('window/sizing shouldCaptureCustom (REVIEW_103 R2 fold-time capture decision)', () => {
  // 折叠瞬间用真实物理尺寸按当前屏 max/default 判 custom。纯决策,不依赖 Electron window。
  it('MED-1: genuine custom physical size on current screen → capture', () => {
    // drag 700x500 on screen-A (max 1880x1040), fold → should capture
    expect(shouldCaptureCustom(700, 500, 1880, 1040, 520, 680)).toBe(true);
  });
  it('CASE C: at default → NOT custom → do not capture', () => {
    expect(shouldCaptureCustom(520, 680, 1880, 1040, 520, 680)).toBe(false);
  });
  it('at max → NOT custom → do not capture', () => {
    expect(shouldCaptureCustom(1880, 1040, 1880, 1040, 520, 680)).toBe(false);
  });
  it('REVIEW_103 R2 CASE E/GROW key: custom 700x500 stays custom on BOTH smaller and bigger screens (cross-display correct)', () => {
    // The whole point of fold-time capture: judge against CURRENT screen geometry at fold moment.
    // 700x500 is custom on a small screen (max 960x700)...
    expect(shouldCaptureCustom(700, 500, 960, 700, 520, 680)).toBe(true);
    // ...and still custom on a big screen (max 3400x1400) — neither max nor default there.
    expect(shouldCaptureCustom(700, 500, 3400, 1400, 520, 680)).toBe(true);
  });
  it('isNear tolerance applies (size within 4px of max counts as max → not captured)', () => {
    expect(shouldCaptureCustom(1878, 1040, 1880, 1040, 520, 680)).toBe(false); // diff 2 → atMax
  });
});
