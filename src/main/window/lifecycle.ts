import { BrowserWindow, app, screen } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';

import {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  resolveIconImage,
  type FloatingWindowState,
} from './_deps';
import { stopInvalidateLoop } from './pin-visual';

/**
 * 创建 BrowserWindow + 注册 ready-to-show / closed listener + dock icon + 状态复位。
 *
 * **生命周期含义**:
 * - 调用方:facade FloatingWindow.create() (main/index.ts bootstrap 起 + macOS dock activate
 *   重建路径 ensureFocusableOnActivate → getFloatingWindow().create())
 * - 单例 recreate 场景:Cmd+W close winA → dock activate 重建 winB,旧 generation 异步
 *   callback 用 capturedWin 防污染 winB (REVIEW_61 R2 LOW codex + R1 MED-A codex)
 * - state 复位 (R3 fix REVIEW_45 MED-2 codex):新 BrowserWindow 是 default 尺寸,旧 compact /
 *   preferredSize / lastNormalSize 残留旧值会语义错乱 → create 末尾把瞬态状态复位与初始尺寸一致
 * - emitCompactChanged 不在 create 重置 (它由 main bootstrap 一次性注入 floating instance,
 *   与 BrowserWindow lifecycle 独立)
 */
export function createImpl(state: FloatingWindowState): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea;
  const x = display.x + display.width - DEFAULT_WIDTH - 20;
  const y = display.y + 60;

  state.win = new BrowserWindow({
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
    icon: resolveIconImage(),
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
      const img = resolveIconImage();
      if (!img.isEmpty()) app.dock?.setIcon(img);
    } catch {
      // ignore
    }
  }

  state.win.setAlwaysOnTop(true, 'floating');
  state.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // REVIEW_61 R2 LOW (codex) + R1 MED-A (codex) fix: BrowserWindow generation guard +
  // 销毁后 stale state.win 自动清。
  //
  // **Generation guard 必要性** (R2 codex 抓):本类是 singleton,Cmd+W close winA → dock activate
  // 重建 winB 期间,winA 注册的 async callback (1.5s fallback show / setInterval flash cb /
  // 'closed' listener 自身)若读 mutable `state.win` 会拿到 winB 误操作。**create() 入口捕获
  // capturedWin = state.win**,所有 callback 用 capturedWin + 加 `state.win !== capturedWin`
  // generation guard,确保跨 close+recreate 不污染新窗口。
  //
  // **'closed' listener** (R1 MED-A):BrowserWindow 销毁(Cmd+W / OS close / 系统强杀)时
  // state.win 字段未清 → 多处 .show() / .focus() / .getOpacity() 撞 destroyed。listener 自动:
  // 1. generation guard `state.win === capturedWin` 防已 recreate 把新 winB 误清
  // 2. stopInvalidateLoop 清 100ms invalidate 计时器
  // 3. clearInterval flashTimer 防 flash cb 跨 generation 改新 winB opacity (R2 codex)
  // 4. clearTimeout fallbackShowTimer 防 1.5s 兜底跨 generation show 新 winB (R2 codex)
  // 5. state.win = null 让 dock activate 重建路径正确触发
  const capturedWin = state.win;
  capturedWin.once('closed', () => {
    // 已被 dock activate → ensureFocusableOnActivate → create() 重建替换 → 不动新 winB
    if (state.win !== capturedWin) return;
    stopInvalidateLoop(state);
    if (state.flashTimer) {
      clearInterval(state.flashTimer);
      state.flashTimer = null;
    }
    if (state.fallbackShowTimer) {
      clearTimeout(state.fallbackShowTimer);
      state.fallbackShowTimer = null;
    }
    state.win = null;
  });

  // 显示策略：优先等 ready-to-show（首屏渲染完，避免白闪）；
  // 但 transparent + vibrancy + 重 backdrop-filter 偶发不触发，加 1.5s 兜底强制 show。
  let shown = false;
  const showOnce = (reason: string): void => {
    // generation guard: 旧 generation callback 跨 close+recreate 到点时 state.win 已是 winB,
    // 严格守门只操作 capturedWin (本 generation 自己的 win),且 capturedWin 已 destroyed 时 skip。
    if (shown || state.win !== capturedWin || capturedWin.isDestroyed()) return;
    shown = true;
    capturedWin.show();
    console.log(`[window] shown via ${reason}`);
  };
  capturedWin.once('ready-to-show', () => showOnce('ready-to-show'));
  capturedWin.webContents.once('did-finish-load', () => showOnce('did-finish-load'));
  // 1.5s 兜底句柄存 instance state,'closed' listener 同步 clearTimeout(R2 LOW codex)
  state.fallbackShowTimer = setTimeout(() => {
    showOnce('fallback-timeout');
    state.fallbackShowTimer = null;
  }, 1500);

  state.win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[window] did-fail-load ${code} ${desc} url=${url}`);
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    state.win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    state.win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // 关闭 macOS 后台节流：默认 true 时，窗口失焦后 Chromium 会对 webContents 的
  // paint pipeline / rAF 做降频，pin 模式下窗口失焦是常态（用户在下层 app 操作），
  // 节流会让 startInvalidateLoop 每 100ms 调的 invalidate 实际频率降到 1-2fps，
  // 残影压不住。Electron 公开 API，无 hack。
  state.win.webContents.setBackgroundThrottling(false);

  // R3 fix REVIEW_45 MED-2 (codex): create() 重建窗口（如 macOS Cmd+W 关窗 + dock activate
  // 触发 ensureFocusableOnActivate 调 create()）时，singleton 旧 state.compact / lastNormalSize /
  // preferredSize 仍是旧值，新 BrowserWindow 是 default 尺寸但语义状态错乱 →
  // 第一次点折叠按钮反向 / preferredSize 残留旧 display 尺寸。在 create 末尾把瞬态状态
  // 复位与新 BrowserWindow 初始尺寸一致。emitCompactChanged 不在 create 里重置 (它由
  // main bootstrap 一次性注入 floating instance,与 BrowserWindow lifecycle 独立)。
  state.compact = false;
  state.preferredSize = null;
  state.lastNormalSize = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  state.lastToggleAt = 0;

  return state.win;
}

/**
 * 关闭窗口 + 显式清理所有定时器 + 重置 emitCompactChanged 引用。
 *
 * **R2 fix REVIEW_45 LOW (claude)**: close 收尾彻底化 — 清 emitCompactChanged 引用防 closure
 * 持有旧 safeSend / webContents (单例 recreate 场景如 macOS dock activate 触发
 * ensureFocusableOnActivate 会新建 BrowserWindow,旧引用会一直被 closure 持着到下次注入)。
 *
 * **REVIEW_61 LOW-1 (claude) fix**: 显式 close 路径也清 flash timer + 复位 opacity,
 * 避免「flash 跑到一半时显式 close 把窗口关掉,但 setInterval timer 句柄仍在 event loop 里」。
 *
 * **REVIEW_61 R2 LOW (codex) fix**: 显式 close 同样清 1.5s 兜底 show 计时器
 * ('closed' listener 也会清,这里是双保险:close() 显式调用早于 'closed' event 时同步生效)。
 */
export function closeImpl(state: FloatingWindowState): void {
  stopInvalidateLoop(state);
  if (state.flashTimer) {
    clearInterval(state.flashTimer);
    state.flashTimer = null;
  }
  if (state.fallbackShowTimer) {
    clearTimeout(state.fallbackShowTimer);
    state.fallbackShowTimer = null;
  }
  state.win?.close();
  state.win = null;
  state.emitCompactChanged = null;
}
