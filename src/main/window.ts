import { BrowserWindow, app, screen, nativeImage } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 680;
const COMPACT_HEIGHT = 64;

/**
 * 应用图标。dev 模式 __dirname 是 out/main/，用项目根 resources/icon.png；
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

  create(): BrowserWindow {
    const display = screen.getPrimaryDisplay().workArea;
    const x = display.x + display.width - DEFAULT_WIDTH - 20;
    const y = display.y + 60;

    this.win = new BrowserWindow({
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
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

    // 显示策略：优先等 ready-to-show（首屏渲染完，避免白闪）；
    // 但 transparent + vibrancy + 重 backdrop-filter 偶发不触发，加 1.5s 兜底强制 show。
    let shown = false;
    const showOnce = (reason: string): void => {
      if (shown || !this.win) return;
      shown = true;
      this.win.show();
      console.log(`[window] shown via ${reason}`);
    };
    this.win.once('ready-to-show', () => showOnce('ready-to-show'));
    this.win.webContents.once('did-finish-load', () => showOnce('did-finish-load'));
    setTimeout(() => showOnce('fallback-timeout'), 1500);

    this.win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[window] did-fail-load ${code} ${desc} url=${url}`);
    });

    if (is.dev && process.env.ELECTRON_RENDERER_URL) {
      this.win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      this.win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    return this.win;
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  setAlwaysOnTop(value: boolean): void {
    if (!this.win) return;
    this.win.setAlwaysOnTop(value, value ? 'floating' : 'normal');
    // macOS：pin 模式下禁用 vibrancy（去掉浅灰基底），让 CSS 主导通透感；
    // 解除 pin 时恢复 under-window vibrancy，得到清晰的实玻璃。
    if (process.platform === 'darwin') {
      this.win.setVibrancy(value ? null : 'under-window');
    }
    // pin + macOS：定时强制 webContents.invalidate() 重绘。
    // 背景：关掉 vibrancy 后，窗口仅靠 CSS backdrop-filter 提供模糊，
    // 而 Chromium 合成器只在窗口本身有事件（移动 / resize / DOM 变化）时
    // 才会重新采样「下方像素」。下层 app 切换 / 桌面动画 / 视频播放时窗口自身没事件，
    // backdrop-filter 持续展示旧快照 → 视觉上是「残影」，需要拖动一下才消失。
    // 200ms 一次（约 5fps）肉眼无感、GPU 开销可忽略，刚好把残影问题压下去。
    // 非 macOS / 非 pin 不需要这个机制：vibrancy 由系统层持续刷新。
    this.stopInvalidateLoop();
    if (value && process.platform === 'darwin') {
      this.startInvalidateLoop();
    }
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
    }, 200);
  }

  private stopInvalidateLoop(): void {
    if (this.invalidateTimer) {
      clearInterval(this.invalidateTimer);
      this.invalidateTimer = null;
    }
  }

  toggleCompact(): boolean {
    if (!this.win) return this.compact;
    this.compact = !this.compact;
    if (this.compact) {
      const [w, h] = this.win.getSize();
      this.lastNormalSize = { width: w, height: h };
      this.win.setSize(this.lastNormalSize.width, COMPACT_HEIGHT, true);
    } else {
      this.win.setSize(this.lastNormalSize.width, this.lastNormalSize.height, true);
    }
    return this.compact;
  }

  setIgnoreMouse(ignore: boolean): void {
    this.win?.setIgnoreMouseEvents(ignore, { forward: true });
  }

  flash(): void {
    // macOS 没有任务栏闪烁的标准 API；此处先实现窗口短促置顶动画作为视觉提示。
    if (!this.win) return;
    const original = this.win.getOpacity();
    let count = 0;
    const t = setInterval(() => {
      if (!this.win || count >= 6) {
        this.win?.setOpacity(original);
        clearInterval(t);
        return;
      }
      this.win.setOpacity(count % 2 === 0 ? 0.5 : original);
      count += 1;
    }, 120);
  }

  close(): void {
    this.stopInvalidateLoop();
    this.win?.close();
    this.win = null;
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
