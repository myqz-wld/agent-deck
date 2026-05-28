import { BrowserWindow, app, screen, nativeImage } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 680;
const COMPACT_HEIGHT = 64;
/** 最小尺寸 — 380×260 留得下 header + 一两条 SessionCard，再小 UI 就崩。 */
const MIN_WIDTH = 380;
const MIN_HEIGHT = 260;
/** display workArea 留边距防贴边遮挡 dock / 状态栏。 */
const MAX_INSET = 40;
/** 判断「当前尺寸是否已等于目标」的容差 — 用户拖窗口边缘后尺寸可能与 setSize 时差 1-2px
 *  (Electron 内部 round / DPR 折算)，直接 `===` 比较会把刚切完的窗口误判为「不在目标态」。 */
const TARGET_TOLERANCE_PX = 4;
/** R3 fix REVIEW_45 LOW (animate race): macOS setBounds(_, true) 异步动画约 250ms,
 *  300ms guard 留 50ms 安全余量(快速连按 < 300ms 时下一次 toggle 入口的 getSize() 拿到
 *  动画中间帧不污染 preferredSize)。Linux/Windows 无 animate 但 guard 也无害。 */
const ANIMATE_GUARD_MS = 300;

/**
 * 应用图标。dev 模式 __dirname 是 build/main/，用项目根 resources/icon.png；
 * 生产模式 electron-builder 会把 resources/ 拷到 app.asar 同级。
 */
function resolveIconPath(): string {
  // 先按 app.getAppPath() 找；找不到回退相对 __dirname。
  return join(app.getAppPath(), 'resources', 'icon.png');
}

export class FloatingWindow {
  private win: BrowserWindow | null = null;
  private compact = false;
  private invalidateTimer: NodeJS.Timeout | null = null;
  private lastNormalSize: { width: number; height: number } = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
  /** 「最大 / 默认」toggle 共享的记忆字段（CHANGELOG_124）。null = 首次使用快捷键前，
   *  fallback 走 default(toggleMaximize 时) / max(toggleDefault 时)。 */
  private preferredSize: { width: number; height: number } | null = null;
  /** main/index.ts bootstrap 时注入 compact 状态变化回调（emit IpcEvent.CompactToggled）。
   *  toggleMaximize / toggleDefault 在 wasCompact && this.compact=false 路径上调一次,
   *  让 renderer App.tsx 的 setCompact(value) 同步本地 state 避免 UI 按钮 label 反转。
   *  optional 风格：调用方在 lazy init 完成前不挂没关系（?.）。
   *  R2 fix REVIEW_45 LOW：close() 必须置 null 防 closure 持有旧 safeSend 引用。 */
  emitCompactChanged: ((compact: boolean) => void) | null = null;
  /** R3 fix REVIEW_45 LOW (animate race): setBounds(_, true) 在 macOS 是异步原生动画(~250ms)，
   *  动画期间 getSize() 取中间帧绕过 rememberIfCustom 短路条件 `=== lastNormalSize`(动画中间值
   *  不等于已写终态)，把中间帧污染进 preferredSize。用 timestamp guard：toggle 入口记 Date.now()，
   *  rememberIfCustom 入口 Date.now() - lastToggleAt < ANIMATE_GUARD_MS 直接 return 不存。
   *  非 macOS 无 animate，guard 也不损害（只是 300ms 内连按不存 custom，可接受）。 */
  private lastToggleAt: number = 0;
  /** 透明视觉开关（Phase 5 Step 5.6 plan mcp-bug-and-feature-batch-20260513）：从原
   *  `transparentWhenPinned` 重命名 + 解耦 alwaysOnTop。true = vibrancy null + CSS
   *  frosted 主导通透；false = vibrancy under-window 实玻璃。
   *  由 main/index.ts 启动时从 settings.windowTransparent 读初始值传进来；之后由
   *  setWindowTransparent 改动。**不再依赖 alwaysOnTopCurrent**：透明独立切换。 */
  private windowTransparent = true;

  create(): BrowserWindow {
    const display = screen.getPrimaryDisplay().workArea;
    const x = display.x + display.width - DEFAULT_WIDTH - 20;
    const y = display.y + 60;

    this.win = new BrowserWindow({
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      // R2 fix REVIEW_45 MED-1：constructor minHeight 设回 MIN_HEIGHT（normal 态底线）；
      // toggleCompact 进 compact 时临时降到 (MIN_WIDTH, COMPACT_HEIGHT)，退 compact 时恢复。
      // 旧 R1 fix 直接设 COMPACT_HEIGHT 会让 normal 态用户手动拖下边沿可拖到 < 260（破 UI）。
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      x,
      y,
      transparent: true,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      vibrancy: 'under-window',
      visualEffectState: 'active',
      titleBarStyle: 'hidden',
      show: false,
      icon: nativeImage.createFromPath(resolveIconPath()),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
      },
    });

    // dev 模式下 macOS Dock 图标默认是 Electron logo；显式设成应用图标。
    // 生产模式由 electron-builder 打包的 .icns 自动接管，这里也设了不会冲突。
    if (process.platform === 'darwin') {
      try {
        const img = nativeImage.createFromPath(resolveIconPath());
        if (!img.isEmpty()) app.dock?.setIcon(img);
      } catch {
        // ignore
      }
    }

    this.win.setAlwaysOnTop(true, 'floating');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // REVIEW_61 R2 LOW (codex) + R1 MED-A (codex) fix: BrowserWindow generation guard +
    // 销毁后 stale this.win 自动清。
    //
    // **Generation guard 必要性** (R2 codex 抓):本类是 singleton,Cmd+W close winA → dock activate
    // 重建 winB 期间,winA 注册的 async callback (1.5s fallback show / setInterval flash cb /
    // 'closed' listener 自身)若读 mutable `this.win` 会拿到 winB 误操作。**create() 入口捕获
    // capturedWin = this.win**,所有 callback 用 capturedWin + 加 `this.win !== capturedWin`
    // generation guard,确保跨 close+recreate 不污染新窗口。
    //
    // **'closed' listener** (R1 MED-A):BrowserWindow 销毁(Cmd+W / OS close / 系统强杀)时
    // this.win 字段未清 → 多处 .show() / .focus() / .getOpacity() 撞 destroyed。listener 自动:
    // 1. generation guard `this.win === capturedWin` 防已 recreate 把新 winB 误清
    // 2. stopInvalidateLoop 清 100ms invalidate 计时器
    // 3. clearInterval flashTimer 防 flash cb 跨 generation 改新 winB opacity (R2 codex)
    // 4. clearTimeout fallbackShowTimer 防 1.5s 兜底跨 generation show 新 winB (R2 codex)
    // 5. this.win = null 让 dock activate 重建路径正确触发
    const capturedWin = this.win;
    capturedWin.once('closed', () => {
      // 已被 dock activate → ensureFocusableOnActivate → create() 重建替换 → 不动新 winB
      if (this.win !== capturedWin) return;
      this.stopInvalidateLoop();
      if (this.flashTimer) {
        clearInterval(this.flashTimer);
        this.flashTimer = null;
      }
      if (this.fallbackShowTimer) {
        clearTimeout(this.fallbackShowTimer);
        this.fallbackShowTimer = null;
      }
      this.win = null;
    });

    // 显示策略：优先等 ready-to-show（首屏渲染完，避免白闪）；
    // 但 transparent + vibrancy + 重 backdrop-filter 偶发不触发，加 1.5s 兜底强制 show。
    let shown = false;
    const showOnce = (reason: string): void => {
      // generation guard: 旧 generation callback 跨 close+recreate 到点时 this.win 已是 winB,
      // 严格守门只操作 capturedWin (本 generation 自己的 win),且 capturedWin 已 destroyed 时 skip。
      if (shown || this.win !== capturedWin || capturedWin.isDestroyed()) return;
      shown = true;
      capturedWin.show();
      console.log(`[window] shown via ${reason}`);
    };
    capturedWin.once('ready-to-show', () => showOnce('ready-to-show'));
    capturedWin.webContents.once('did-finish-load', () => showOnce('did-finish-load'));
    // 1.5s 兜底句柄存 instance state,'closed' listener 同步 clearTimeout(R2 LOW codex)
    this.fallbackShowTimer = setTimeout(() => {
      showOnce('fallback-timeout');
      this.fallbackShowTimer = null;
    }, 1500);

    this.win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[window] did-fail-load ${code} ${desc} url=${url}`);
    });

    if (is.dev && process.env.ELECTRON_RENDERER_URL) {
      this.win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    // 关闭 macOS 后台节流：默认 true 时，窗口失焦后 Chromium 会对 webContents 的
    // paint pipeline / rAF 做降频，pin 模式下窗口失焦是常态（用户在下层 app 操作），
    // 节流会让 startInvalidateLoop 每 100ms 调的 invalidate 实际频率降到 1-2fps，
    // 残影压不住。Electron 公开 API，无 hack。
    this.win.webContents.setBackgroundThrottling(false);

    // R3 fix REVIEW_45 MED-2 (codex): create() 重建窗口（如 macOS Cmd+W 关窗 + dock activate
    // 触发 ensureFocusableOnActivate 调 create()）时，singleton 旧 this.compact / lastNormalSize /
    // preferredSize 仍是旧值，新 BrowserWindow 是 default 尺寸但语义状态错乱 →
    // 第一次点折叠按钮反向 / preferredSize 残留旧 display 尺寸。在 create 末尾把瞬态状态
    // 复位与新 BrowserWindow 初始尺寸一致。emitCompactChanged 不在 create 里重置 (它由
    // main bootstrap 一次性注入 floating instance,与 BrowserWindow lifecycle 独立)。
    this.compact = false;
    this.preferredSize = null;
    this.lastNormalSize = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    this.lastToggleAt = 0;

    return this.win;
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  setAlwaysOnTop(value: boolean): void {
    if (!this.win) return;
    this.win.setAlwaysOnTop(value, value ? 'floating' : 'normal');
    // Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）：透明 / 置顶解耦后，
    // vibrancy 仅由 windowTransparent 决定，不再 && alwaysOnTop。这样四种组合都合法：
    //   pin + 透明（vibrancy null + frosted）/ pin + 不透明（vibrancy under-window）/
    //   不 pin + 透明（仍 vibrancy null）/ 不 pin + 不透明（vibrancy under-window）。
    if (process.platform === 'darwin') {
      this.win.setVibrancy(this.windowTransparent ? null : 'under-window');
    }
    // pin + macOS：定时强制 webContents.invalidate() 触发 NSWindow 重新与桌面合成，
    // 顺带把下层 app 最新像素拿进来。
    //
    // 注意：CHANGELOG_24 当时的认知有误——这里**不是** "CSS backdrop-filter 在模糊
    // 下层 app 像素"。pin 态下 backdrop-filter 模糊的是窗口自身 layer 的内容
    // （基本是空的），下层 app 的像素是 NSWindow 在 surface 提交后做的 source-over
    // 合成，根本没经过 blur。invalidate 的真实作用：触发 Chromium 提交一帧 surface
    // → NSWindow 顺带与桌面背景重新合成 → 顺便取下层 app 最新像素。
    // 所以**这个频率 = 下层桌面感知 fps**，5fps 的 CHANGELOG_24 设置在动态场景
    // （滚动 / 视频 / 切 app）下肉眼能瞥到旧帧 —— 用户实测有"残影"。
    //
    // CHANGELOG_35 调整：
    // - 200ms (5fps) → 100ms (10fps)：动态场景几乎察觉不到延迟，GPU 开销仍可忽略
    // - 配合 webContents.setBackgroundThrottling(false)（create 时一次性调）确保
    //   invalidate 在窗口失焦时不被压制
    // - 文字残影的另一个根因（::before mix-blend-mode 的 group surface 缓存）
    //   在 globals.css 端通过 pin 态 display:none ::before 治根了
    //
    // 非 macOS / 非 pin 不需要这个机制：vibrancy 由系统层持续刷新。
    this.stopInvalidateLoop();
    if (value && process.platform === 'darwin') {
      this.kickRepaintAfterPin();
      this.startInvalidateLoop();
    }
  }

  // CHANGELOG_35 之后仍有用户反馈：进入 pin 模式那一瞬间的旧帧（含全量文字）会"印"
  // 在玻璃上，必须人工拖一下窗口大小才消失。根因：
  // - vibrancy 切到 null 是异步生效，前几帧 macOS 系统材质还没真关；
  // - 进入 pin 瞬间的 native surface / Chromium compositor 合成层缓存，单靠
  //   webContents.invalidate() 冲不掉（即使 100ms loop 已开也没用）；
  // - 拖动窗口 = 触发完整 ViewSizeChanged → relayout/repaint → 旧 surface 必被替换。
  // 解法：模拟一次 resize —— 同步 setContentSize(+1px)，下一个 macro task 调回原值，
  // 触发 Chromium 完整 layout/repaint 路径把旧 surface 冲干净。两次调用跨 macro task
  // 防止 Chromium size 去重合并，1px 高度变化在 setImmediate 一个 runloop 内完成，
  // 肉眼难察。
  private kickRepaintAfterPin(): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const [width, height] = w.getContentSize();
    w.setContentSize(width, height + 1);
    setImmediate(() => {
      const w2 = this.win;
      if (!w2 || w2.isDestroyed()) return;
      w2.setContentSize(width, height);
    });
  }

  private startInvalidateLoop(): void {
    if (this.invalidateTimer) return;
    this.invalidateTimer = setInterval(() => {
      const w = this.win;
      if (!w || w.isDestroyed() || w.webContents.isDestroyed()) {
        this.stopInvalidateLoop();
        return;
      }
      w.webContents.invalidate();
    }, 100);
  }

  private stopInvalidateLoop(): void {
    if (this.invalidateTimer) {
      clearInterval(this.invalidateTimer);
      this.invalidateTimer = null;
    }
  }

  /** 用户在设置里 / 快捷键切「窗口透明」开关时调；立即重新应用 vibrancy（不依赖 pin 状态）。
   *  Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）：从原 setTransparentWhenPinned
   *  重命名 + 解耦 alwaysOnTop。透明独立于 pin —— 不 pin 也能切换透明视觉，让用户选择. */
  setWindowTransparent(value: boolean): void {
    this.windowTransparent = value;
    if (!this.win || process.platform !== 'darwin') return;
    // 解耦后无论 pin 不 pin 都立即应用 vibrancy 切换。startInvalidateLoop 是 pin 时启的
    // 100ms 重绘循环，与透明切换正交（不需在此动）。
    this.win.setVibrancy(value ? null : 'under-window');
  }

  toggleCompact(): boolean {
    if (!this.win) return this.compact;
    this.compact = !this.compact;
    if (this.compact) {
      const [w, h] = this.win.getSize();
      // R2 fix REVIEW_45 MED-1：进 compact 前必须临时降 minimumSize，否则 constructor
      // minHeight=MIN_HEIGHT=260 会让 Electron 直接拒 setSize(W, 64) 把窗口卡在 260px。
      this.win.setMinimumSize(MIN_WIDTH, COMPACT_HEIGHT);
      this.lastNormalSize = { width: w, height: h };
      this.win.setSize(this.lastNormalSize.width, COMPACT_HEIGHT, true);
    } else {
      // 退 compact：lastNormalSize.height 可能是 R1 旧路径残留的 < MIN_HEIGHT 值（如用户
      // 在 R1 minHeight=64 期间手动拖到 100px 后折叠保存的 100px），先 clamp 到 MIN_HEIGHT
      // 防展开后仍不可用；setMinimumSize 恢复 normal 底线（必须在 setSize 之前调，否则
      // 旧 minimumSize=COMPACT_HEIGHT 不会反向 enlarge 当前 64px → setSize(_, MIN_HEIGHT)
      // 失败 silent）。
      this.win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
      const restoreW = Math.max(MIN_WIDTH, this.lastNormalSize.width);
      const restoreH = Math.max(MIN_HEIGHT, this.lastNormalSize.height);
      this.win.setSize(restoreW, restoreH, true);
      this.lastNormalSize = { width: restoreW, height: restoreH };
    }
    return this.compact;
  }

  /**
   * 一键放大到屏幕最大 / toggle 回上次「自定义」尺寸（CHANGELOG_124；R1 fix REVIEW_45 HIGH-1 setSize→setBounds + MED-2 clamp 后 isNear 再判 + MED-1 emit compactToggled）。
   *
   * 行为：
   * - 当前 ≠ max：先 `rememberIfCustom` 记录当前到 preferredSize（仅当当前既非 max 也非 default），
   *   然后 setBounds 居中到屏幕 workArea 最大（留 40px 边距）
   * - 当前 = max（容差 4px）：恢复 preferredSize；preferredSize clamp 后仍撞 max 时回退默认 520×680
   * - compact 态被调用先退出 compact + emit `IpcEvent.CompactToggled` 让 renderer 同步 UI
   *
   * 关键 fix（REVIEW_45 R1）：
   * - HIGH-1：setSize 不改位置 → max 后窗口右边界离屏（默认 x 靠右 20px 创建）。
   *   改 `setBounds({x, y, width, height})` + max 时居中到当前所在 display。default 时
   *   保留当前 x/y 但 clamp 到 display 内（避免 default 也离屏）。
   * - MED-2：preferredSize fallback 必须**先 clamp 再判 isNear(target)**。跨屏 / 分辨率变小后
   *   原 preferredSize > 当前 maxW，朴素 isNear(fb, max)=false 选 fb 但 clamp 后 == max → 死循环。
   *   修法：clamp 后用 `isNear(clampedW, clampedH, maxW, maxH)` 再判一次，撞顶则走 alt (default)。
   * - MED-1：wasCompact 路径 emit `compact-toggled` event 让 renderer 把按钮 label 翻成「折叠」。
   *
   * 与 `toggleDefault` 共享 `preferredSize`：只记录用户「手动拖出来的尺寸」，不让 toggle
   * 自己造成的 default ↔ max 跳变污染记忆字段（否则会出现「按 + 切 max → 再按 + 回 default
   *  → 再按 - 不动」的死循环）。
   */
  toggleMaximize(): { width: number; height: number } {
    const w = this.win;
    if (!w || w.isDestroyed()) return { width: 0, height: 0 };
    const wasCompact = this.compact;
    if (this.compact) {
      this.compact = false;
      // R2 fix REVIEW_45 MED-1: 退 compact 时恢复 normal 底线 minimumSize（与 toggleCompact 退出路径同模式）
      w.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
      this.emitCompactChanged?.(false);
    }

    const display = screen.getDisplayMatching(w.getBounds()).workArea;
    const maxW = Math.max(MIN_WIDTH, display.width - MAX_INSET);
    const maxH = Math.max(MIN_HEIGHT, display.height - MAX_INSET);
    const defaultW = Math.min(maxW, DEFAULT_WIDTH);
    const defaultH = Math.min(maxH, DEFAULT_HEIGHT);

    const [rawW, rawH] = w.getSize();
    const curW = wasCompact ? this.lastNormalSize.width : rawW;
    const curH = wasCompact ? this.lastNormalSize.height : rawH;
    const atMax = this.isNear(curW, curH, maxW, maxH);

    let nextW: number;
    let nextH: number;
    if (atMax) {
      // 撞顶保护两层：(1) 朴素 isNear(fb, max) 排掉等于 max 的 fb；(2) clamp 后再 isNear
      // 一次（fb < max 但 fb > 当前屏 maxW 时 clamp 退化为 max，仍要 fallback 到 default）
      const fb = this.preferredSize;
      let fbW: number;
      let fbH: number;
      if (fb && !this.isNear(fb.width, fb.height, maxW, maxH)) {
        fbW = Math.max(MIN_WIDTH, Math.min(maxW, fb.width));
        fbH = Math.max(MIN_HEIGHT, Math.min(maxH, fb.height));
        if (this.isNear(fbW, fbH, maxW, maxH)) {
          // clamp 后撞顶 → preferredSize 在当前 display 上等价 max，走 alt fallback (default)
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
      this.rememberIfCustom(curW, curH, maxW, maxH, defaultW, defaultH);
      nextW = maxW;
      nextH = maxH;
    }

    // HIGH-1: setSize 不改位置 → 默认靠右创建的窗口 max 后右边界离屏。改 setBounds 居中。
    // max 时居中到当前所在 display；fallback / 其他时保留当前 x/y 但 clamp 到 display 内。
    const bounds = w.getBounds();
    return this.applyTargetSize(w, display, bounds, maxW, maxH, nextW, nextH);
  }

  /**
   * 一键回到默认 520×680 / toggle 回上次「自定义」尺寸（CHANGELOG_124；R1 fix REVIEW_45 同条款）。
   *
   * 与 `toggleMaximize` 共享 `preferredSize` 记忆字段，见该方法 JSDoc。
   */
  toggleDefault(): { width: number; height: number } {
    const w = this.win;
    if (!w || w.isDestroyed()) return { width: 0, height: 0 };
    const wasCompact = this.compact;
    if (this.compact) {
      this.compact = false;
      // R2 fix REVIEW_45 MED-1: 同 toggleMaximize 退 compact 路径
      w.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
      this.emitCompactChanged?.(false);
    }

    const display = screen.getDisplayMatching(w.getBounds()).workArea;
    const maxW = Math.max(MIN_WIDTH, display.width - MAX_INSET);
    const maxH = Math.max(MIN_HEIGHT, display.height - MAX_INSET);
    const defaultW = Math.min(maxW, DEFAULT_WIDTH);
    const defaultH = Math.min(maxH, DEFAULT_HEIGHT);

    const [rawW, rawH] = w.getSize();
    const curW = wasCompact ? this.lastNormalSize.width : rawW;
    const curH = wasCompact ? this.lastNormalSize.height : rawH;
    const atDefault = this.isNear(curW, curH, defaultW, defaultH);

    let nextW: number;
    let nextH: number;
    if (atDefault) {
      const fb = this.preferredSize;
      let fbW: number;
      let fbH: number;
      if (fb && !this.isNear(fb.width, fb.height, defaultW, defaultH)) {
        fbW = Math.max(MIN_WIDTH, Math.min(maxW, fb.width));
        fbH = Math.max(MIN_HEIGHT, Math.min(maxH, fb.height));
        if (this.isNear(fbW, fbH, defaultW, defaultH)) {
          // clamp 后撞 default → preferredSize 在当前 display 上等价 default，走 alt fallback (max)
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
      this.rememberIfCustom(curW, curH, maxW, maxH, defaultW, defaultH);
      nextW = defaultW;
      nextH = defaultH;
    }

    const bounds = w.getBounds();
    return this.applyTargetSize(w, display, bounds, maxW, maxH, nextW, nextH);
  }

  /** R2 fix REVIEW_45 INFO-2 (claude): toggleMaximize / toggleDefault 收尾 9 行重复抽 helper。
   *  max 时居中到当前 display；非 max 保留当前 x/y 但 clamp 到 display 内（防 default
   *  toggle 后窗口仍在屏外）。setBounds 用 animate=true 带原生动画。 */
  private applyTargetSize(
    w: BrowserWindow,
    display: { x: number; y: number; width: number; height: number },
    bounds: { x: number; y: number; width: number; height: number },
    maxW: number,
    maxH: number,
    nextW: number,
    nextH: number,
  ): { width: number; height: number } {
    const targetIsMax = nextW === maxW && nextH === maxH;
    const { x, y } = targetIsMax
      ? this.centerInDisplay(display, nextW, nextH)
      : this.clampPositionInDisplay(display, bounds.x, bounds.y, nextW, nextH);
    w.setBounds({ x, y, width: nextW, height: nextH }, true);
    this.lastNormalSize = { width: nextW, height: nextH };
    // R3 fix REVIEW_45 LOW (animate race): 记录 toggle 时间戳 → rememberIfCustom 入口
    // 在 ANIMATE_GUARD_MS 内 return 短路，防 macOS setBounds animate 中间帧污染 preferredSize。
    this.lastToggleAt = Date.now();
    return { width: nextW, height: nextH };
  }

  /** 仅当当前尺寸既非 max 也非 default 时把它存进 preferredSize —— 即「用户手动拖出
   *  来的中间尺寸」。toggle 自身在 max ↔ default 之间跳的尺寸不污染记忆字段。
   *
   *  **R2 fix REVIEW_45 MED-2 修法 (a)**：入口加 lastNormalSize 短路 —— 跨屏后用户没拖,
   *  窗口物理尺寸仍是跨屏前 toggle 设的旧 max/default 值（Electron 不自动缩窗口），与新屏
   *  isNear 判断都 false 走 rememberIfCustom → 旧 toggle 尺寸被当 "custom" 覆写真实偏好。
   *  短路条件：curSize === lastNormalSize → 用户没主动拖过 → 不存。代价：用户精确手动拖回
   *  上次 toggle 同尺寸（极罕见）也不被记，可接受。
   *
   *  **in-memory only**：重启应用 preferredSize 清零（settings.json 不持久化）—— 与
   *  windowTransparent / alwaysOnTop 不同的取舍：尺寸偏好通常是"本次会话临时"语义,
   *  长跨度持久化反而误导（重启场景常对应 display / 工作流变化）。如未来用户报，再走
   *  settings 升级。 */
  private rememberIfCustom(
    curW: number,
    curH: number,
    maxW: number,
    maxH: number,
    defaultW: number,
    defaultH: number,
  ): void {
    // R2 MED-2 短路: 跨屏后窗口物理尺寸 == 上次 toggle 设的 lastNormalSize（用户没拖）→ 不存
    if (curW === this.lastNormalSize.width && curH === this.lastNormalSize.height) return;
    // R3 LOW (animate race) 短路: macOS setBounds animate=true 期间 getSize 取动画中间帧,
    // 不等于已写终态 lastNormalSize 绕过上面短路。300ms guard 内不存，避免污染 preferredSize。
    if (Date.now() - this.lastToggleAt < ANIMATE_GUARD_MS) return;
    const atMax = this.isNear(curW, curH, maxW, maxH);
    const atDefault = this.isNear(curW, curH, defaultW, defaultH);
    if (!atMax && !atDefault) {
      this.preferredSize = { width: curW, height: curH };
    }
  }

  private isNear(aW: number, aH: number, bW: number, bH: number): boolean {
    return (
      Math.abs(aW - bW) <= TARGET_TOLERANCE_PX && Math.abs(aH - bH) <= TARGET_TOLERANCE_PX
    );
  }

  /** 居中到 display workArea；用 floor 防 1px 偏右导致 setBounds round 上越界。
   *  R2 fix REVIEW_45 LOW (claude INFO + codex LOW 双方): 极小屏 (display.width < w) 或
   *  display.x 为负 (左屏在主屏左侧) 时 center 算式可能输出 < display.x，导致窗口标题区
   *  跑出 workArea 左/上。兜底 Math.max 强制不越上界。 */
  private centerInDisplay(
    display: { x: number; y: number; width: number; height: number },
    w: number,
    h: number,
  ): { x: number; y: number } {
    return {
      x: Math.max(display.x, display.x + Math.floor((display.width - w) / 2)),
      y: Math.max(display.y, display.y + Math.floor((display.height - h) / 2)),
    };
  }

  /** 保留当前 x/y 但 clamp 到 display 内（防止 default toggle 后窗口仍在屏外）。
   *  R2 fix REVIEW_45 LOW: w > display.width 时 maxX < minX，min(maxX, x) 后 max(minX, ...)
   *  会强制走 minX (= display.x)，等价 "贴左 + 部分越右"。极小屏 / 窗口比屏宽场景体感正确。 */
  private clampPositionInDisplay(
    display: { x: number; y: number; width: number; height: number },
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

  setIgnoreMouse(ignore: boolean): void {
    this.win?.setIgnoreMouseEvents(ignore, { forward: true });
  }

  /** REVIEW_61 LOW-1 (claude) fix: flash 重入保护。第二次调用必先 clearInterval 旧 timer +
   *  setOpacity(savedOriginal) 复位 baseline,再起新轮。避免「A 进行中 setOpacity(0.5) → B 进入
   *  getOpacity() 取到 0.5 当 baseline → B 结束 setOpacity(0.5) 永久半透明」。 */
  private flashTimer: NodeJS.Timeout | null = null;
  private flashOriginalOpacity = 1;
  /** REVIEW_61 R2 LOW (codex) fix: 1.5s 兜底 show 计时器句柄存到 instance state,'closed' listener
   *  同步 clearTimeout 防「winA close + dock activate 重建 winB → 旧 1.5s fallback 到点 showOnce
   *  看到 winB 非 destroyed 调 winB.show() 干扰新窗口生命周期」。 */
  private fallbackShowTimer: NodeJS.Timeout | null = null;

  flash(): void {
    // macOS 没有任务栏闪烁的标准 API；此处先实现窗口短促置顶动画作为视觉提示。
    if (!this.win || this.win.isDestroyed()) return;
    // 重入: 旧 timer 仍在 → 先 clear + 复位 opacity 再起新轮(保 savedOriginal 一致性)
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
      this.win.setOpacity(this.flashOriginalOpacity);
    }
    // REVIEW_61 R2 LOW (codex) fix: capture generation,setInterval cb 跨 close+recreate
    // 不污染新 winB opacity('closed' listener 已加 clearInterval flashTimer 兜底,这里 generation
    // guard 是双保险:如有 close → recreate 极快导致 'closed' clearInterval 与新 setInterval 注册
    // 时序错开的极端边界,仍能 skip 不操作新 winB)。
    const capturedWin = this.win;
    this.flashOriginalOpacity = capturedWin.getOpacity();
    let count = 0;
    this.flashTimer = setInterval(() => {
      // generation guard: this.win 已切到 winB / capturedWin 已 destroyed → 退出不复位 opacity
      // (复位是为本 generation 自己 baseline,跨 generation 复位会污染 winB 真实 opacity)
      if (this.win !== capturedWin || capturedWin.isDestroyed() || count >= 6) {
        if (this.win === capturedWin && !capturedWin.isDestroyed()) {
          capturedWin.setOpacity(this.flashOriginalOpacity);
        }
        if (this.flashTimer) clearInterval(this.flashTimer);
        this.flashTimer = null;
        return;
      }
      capturedWin.setOpacity(count % 2 === 0 ? 0.5 : this.flashOriginalOpacity);
      count += 1;
    }, 120);
  }

  close(): void {
    this.stopInvalidateLoop();
    // REVIEW_61 LOW-1 (claude) fix: 显式 close 路径也清 flash timer + 复位 opacity,
    // 避免「flash 跑到一半时显式 close 把窗口关掉,但 setInterval timer 句柄仍在 event loop 里」。
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    // REVIEW_61 R2 LOW (codex) fix: 显式 close 同样清 1.5s 兜底 show 计时器
    // ('closed' listener 也会清,这里是双保险:close() 显式调用早于 'closed' event 时同步生效)
    if (this.fallbackShowTimer) {
      clearTimeout(this.fallbackShowTimer);
      this.fallbackShowTimer = null;
    }
    this.win?.close();
    this.win = null;
    // R2 fix REVIEW_45 LOW (claude)：close 收尾彻底化 — 清 emitCompactChanged 引用防 closure
    // 持有旧 safeSend / webContents (单例 recreate 场景如 macOS dock activate 触发
    // ensureFocusableOnActivate 会新建 BrowserWindow,旧引用会一直被 closure 持着到下次注入)
    this.emitCompactChanged = null;
  }
}

let instance: FloatingWindow | null = null;

export function getFloatingWindow(): FloatingWindow {
  if (!instance) instance = new FloatingWindow();
  return instance;
}

export function ensureFocusableOnActivate(): void {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      getFloatingWindow().create();
    }
  });
}
