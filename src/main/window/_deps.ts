import { BrowserWindow, app, nativeImage } from 'electron';
import { join } from 'node:path';

export const DEFAULT_WIDTH = 520;
export const DEFAULT_HEIGHT = 680;
export const COMPACT_HEIGHT = 64;
/** 最小尺寸 — 380×260 留得下 header + 一两条 SessionCard，再小 UI 就崩。 */
export const MIN_WIDTH = 380;
export const MIN_HEIGHT = 260;
/** display workArea 留边距防贴边遮挡 dock / 状态栏。 */
export const MAX_INSET = 40;
/** 判断「当前尺寸是否已等于目标」的容差 — 用户拖窗口边缘后尺寸可能与 setSize 时差 1-2px
 *  (Electron 内部 round / DPR 折算)，直接 `===` 比较会把刚切完的窗口误判为「不在目标态」。 */
export const TARGET_TOLERANCE_PX = 4;
/** R3 fix REVIEW_45 LOW (animate race): macOS setBounds(_, true) 异步动画约 250ms,
 *  300ms guard 留 50ms 安全余量(快速连按 < 300ms 时下一次 toggle 入口的 getSize() 拿到
 *  动画中间帧不污染 preferredSize)。Linux/Windows 无 animate 但 guard 也无害。 */
export const ANIMATE_GUARD_MS = 300;

/**
 * 应用图标。dev 模式 __dirname 是 build/main/，用项目根 resources/icon.png；
 * 生产模式 electron-builder 会把 resources/ 拷到 app.asar 同级。
 */
export function resolveIconPath(): string {
  return join(app.getAppPath(), 'resources', 'icon.png');
}

/** Display workArea 几何 (Electron screen.getDisplay*().workArea 同款形状)。 */
export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * FloatingWindow 内部 mutable state — facade class 持有为 `_state` 字段;
 * 子模块 free function 通过 `state: FloatingWindowState` 参数 read/write 同一引用。
 *
 * 设计意图(Step 4.7 mini-spike user confirm):
 * - class fields 11 个全收敛进单一 state object,避免 free function 接 11 个 args 散乱
 * - emitCompactChanged 也进 state — 因为 close() 必须置 null 防 closure 持旧 safeSend 引用 (R2 fix REVIEW_45 LOW),
 *   close 重置语义属 state mutation 范畴;facade class 用 getter/setter forwarder 暴露给 main/index.ts:294 注入 caller (byte-identical API)
 * - emitCompactChanged 由 main/index.ts bootstrap 一次性注入 floating instance,与 BrowserWindow lifecycle 独立 (create() 不在内重置)
 */
export interface FloatingWindowState {
  win: BrowserWindow | null;
  compact: boolean;
  invalidateTimer: NodeJS.Timeout | null;
  lastNormalSize: { width: number; height: number };
  /** 「最大 / 默认」toggle 共享的记忆字段（CHANGELOG_124）。null = 首次使用快捷键前，
   *  fallback 走 default(toggleMaximize 时) / max(toggleDefault 时)。 */
  preferredSize: { width: number; height: number } | null;
  /** R3 fix REVIEW_45 LOW (animate race): setBounds(_, true) 在 macOS 是异步原生动画(~250ms)，
   *  动画期间 getSize() 取中间帧绕过 rememberIfCustom 短路条件 `=== lastNormalSize`(动画中间值
   *  不等于已写终态)，把中间帧污染进 preferredSize。用 timestamp guard：toggle 入口记 Date.now()，
   *  rememberIfCustom 入口 Date.now() - lastToggleAt < ANIMATE_GUARD_MS 直接 return 不存。
   *  非 macOS 无 animate，guard 也不损害（只是 300ms 内连按不存 custom，可接受）。 */
  lastToggleAt: number;
  /** 透明视觉开关（Phase 5 Step 5.6 plan mcp-bug-and-feature-batch-20260513）：从原
   *  `transparentWhenPinned` 重命名 + 解耦 alwaysOnTop。true = vibrancy null + CSS
   *  frosted 主导通透；false = vibrancy under-window 实玻璃。
   *  由 main/index.ts 启动时从 settings.windowTransparent 读初始值传进来；之后由
   *  setWindowTransparent 改动。**不再依赖 alwaysOnTopCurrent**：透明独立切换。 */
  windowTransparent: boolean;
  /** REVIEW_61 LOW-1 (claude) fix: flash 重入保护 timer 句柄。close()/'closed' listener 同步 clearInterval。 */
  flashTimer: NodeJS.Timeout | null;
  flashOriginalOpacity: number;
  /** REVIEW_61 R2 LOW (codex) fix: 1.5s 兜底 show 计时器句柄存到 instance state,'closed' listener
   *  同步 clearTimeout 防「winA close + dock activate 重建 winB → 旧 1.5s fallback 到点 showOnce
   *  看到 winB 非 destroyed 调 winB.show() 干扰新窗口生命周期」。 */
  fallbackShowTimer: NodeJS.Timeout | null;
  /** main/index.ts bootstrap 时注入 compact 状态变化回调（emit IpcEvent.CompactToggled）。
   *  toggleMaximize / toggleDefault 在 wasCompact && this.compact=false 路径上调一次,
   *  让 renderer App.tsx 的 setCompact(value) 同步本地 state 避免 UI 按钮 label 反转。
   *  optional 风格：调用方在 lazy init 完成前不挂没关系（?.）。
   *  R2 fix REVIEW_45 LOW：close() 必须置 null 防 closure 持有旧 safeSend 引用。 */
  emitCompactChanged: ((compact: boolean) => void) | null;
}

/** 创建初始 FloatingWindowState — facade ctor 调用一次。 */
export function createInitialState(): FloatingWindowState {
  return {
    win: null,
    compact: false,
    invalidateTimer: null,
    lastNormalSize: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
    preferredSize: null,
    lastToggleAt: 0,
    windowTransparent: true,
    flashTimer: null,
    flashOriginalOpacity: 1,
    fallbackShowTimer: null,
    emitCompactChanged: null,
  };
}

/** 应用图标 NativeImage — create 时设 dock icon 用。 */
export function resolveIconImage(): Electron.NativeImage {
  return nativeImage.createFromPath(resolveIconPath());
}
