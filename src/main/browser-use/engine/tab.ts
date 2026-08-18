/**
 * One engine tab = one isolated Electron window plus its CDP bridge.
 *
 * Window options are the security contract and must not be relaxed: a non-persistent per-owner
 * partition, sandboxing, context isolation, no Node integration, web security on, and denied
 * window-open requests.
 *
 * Only `loadURL`, `show`, `focus`, `close`, `destroy`, `isDestroyed`, the `focus`/`closed` events,
 * and `webContents.{debugger,getTitle,getURL,setWindowOpenHandler}` are used on the creation path,
 * so a lightweight window double is enough for protocol-level tests. Semantic actions reach for
 * `executeJavaScript`, `capturePage`, and `sendInputEvent` lazily and report a clear error when a
 * window double does not provide them.
 */

import {
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Session,
} from 'electron';

import { CdpBridge, withTimeout } from './cdp';
import { CDP_TIMEOUT_MS, DEFAULT_WINDOW_TITLE, INITIAL_URL, type TabInfo } from './types';
import { BrowserWindowTabSurface, type EngineTabSurface } from './surface';

const hardenedBrowserSessions = new WeakSet<Session>();

/**
 * Browser partitions load arbitrary remote content, so Electron's default permission policy is too
 * broad. Install one deny-by-default policy per partition session before the first navigation.
 */
export function hardenBrowserSession(browserSession: Session): void {
  if (hardenedBrowserSessions.has(browserSession)) return;
  hardenedBrowserSessions.add(browserSession);

  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
  browserSession.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  browserSession.on('select-serial-port', (event, _ports, _webContents, callback) => {
    event.preventDefault();
    callback('');
  });
  browserSession.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
}

export interface EngineTabDeps {
  id: number;
  surface?: EngineTabSurface;
  /** Compatibility seam for existing focused tests and fixtures. Production supplies surface. */
  window?: BrowserWindow;
  onActivated: (tabId: number) => void;
  onClosed: (tabId: number) => void;
}

export function buildTabWindowOptions(
  partition: string,
  title = DEFAULT_WINDOW_TITLE,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 900,
    show: false,
    // Background tabs are the default, so the renderer must still paint for screenshots and layout
    // reads to work while the window was never shown. Electron defaults this to true; pinning it
    // documents the dependency.
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    title,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  };
}

export class EngineTab {
  readonly id: number;
  readonly cdp: CdpBridge;
  private readonly surface: EngineTabSurface;
  private readonly unsubscribe: Array<() => void>;

  constructor(deps: EngineTabDeps) {
    this.id = deps.id;
    if (deps.surface == null && deps.window == null) {
      throw new Error('EngineTab requires a Browser surface.');
    }
    this.surface = deps.surface ?? new BrowserWindowTabSurface(deps.window!);
    this.cdp = new CdpBridge(() => this.surface.webContents.debugger);

    hardenBrowserSession(this.surface.webContents.session);
    this.surface.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.unsubscribe = [
      this.surface.onActivated(() => deps.onActivated(this.id)),
      this.surface.onClosed(() => {
        for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
        deps.onClosed(this.id);
      }),
    ];
  }

  isDestroyed(): boolean {
    return this.surface.isDestroyed();
  }

  info(active: boolean): TabInfo {
    const destroyed = this.isDestroyed();
    return {
      id: this.id,
      title: destroyed ? '' : this.surface.webContents.getTitle(),
      url: destroyed ? '' : this.surface.webContents.getURL() || INITIAL_URL,
      active,
    };
  }

  url(): string {
    return this.isDestroyed() ? '' : this.surface.webContents.getURL() || INITIAL_URL;
  }

  title(): string {
    return this.isDestroyed() ? '' : this.surface.webContents.getTitle();
  }

  show(): void {
    if (this.isDestroyed()) return;
    this.surface.requestShow();
  }

  close(): void {
    // Automation owns these hidden tabs outright. BrowserWindow.close() can be cancelled by a
    // hostile beforeunload handler, which would leave the renderer alive while both fronts report
    // success. destroy() is synchronous and cannot be vetoed by page content.
    if (!this.isDestroyed()) this.surface.destroy();
  }

  destroy(): void {
    if (!this.isDestroyed()) this.surface.destroy();
  }

  async loadUrl(url: string): Promise<void> {
    this.assertAlive();
    await this.surface.loadURL(url);
  }

  async reload(): Promise<void> {
    this.assertAlive();
    this.surface.webContents.reload();
    await this.waitForSettle();
  }

  async executeJs<T = unknown>(
    expression: string,
    options: { userGesture?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    this.assertAlive();
    const contents = this.surface.webContents as unknown as {
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<T>;
    };
    if (typeof contents.executeJavaScript !== 'function') {
      throw new Error('This browser tab cannot evaluate JavaScript.');
    }
    return withTimeout(
      contents.executeJavaScript(expression, options.userGesture === true),
      options.timeoutMs ?? CDP_TIMEOUT_MS,
      'Browser page JavaScript timed out.',
    );
  }

  async capturePng(maxWidth?: number): Promise<Buffer> {
    this.assertAlive();
    const contents = this.surface.webContents as unknown as {
      capturePage?: () => Promise<{
        toPNG: () => Buffer;
        getSize: () => { width: number; height: number };
        resize: (options: { width: number }) => { toPNG: () => Buffer };
      }>;
    };
    if (typeof contents.capturePage !== 'function') {
      throw new Error('This browser tab cannot capture screenshots.');
    }
    const image = await contents.capturePage();
    if (maxWidth != null && image.getSize().width > maxWidth) {
      return image.resize({ width: maxWidth }).toPNG();
    }
    return image.toPNG();
  }

  /**
   * CDP screenshot clip sizes are CSS pixels, while encoded PNG dimensions include the display's
   * device scale factor. Account for Retina/HiDPI output so `maxWidth` remains a physical-pixel
   * bound consistent with `nativeImage.resize()` in the viewport path.
   */
  deviceScaleFactor(): number {
    return this.surface.deviceScaleFactor();
  }

  /**
   * Electron only delivers synthesized input events to a focused window, so a background tab must
   * fall back to script-dispatched keys. Reporting false here is normal, not a failure.
   */
  canSendInputEvents(): boolean {
    if (this.isDestroyed()) return false;
    return this.surface.canSendInputEvents();
  }

  sendKey(keyCode: string): boolean {
    this.assertAlive();
    if (!this.canSendInputEvents()) return false;
    const contents = this.surface.webContents as unknown as {
      sendInputEvent?: (event: Record<string, unknown>) => void;
    };
    if (typeof contents.sendInputEvent !== 'function') return false;
    contents.sendInputEvent({ type: 'keyDown', keyCode });
    contents.sendInputEvent({ type: 'char', keyCode });
    contents.sendInputEvent({ type: 'keyUp', keyCode });
    return true;
  }

  /**
   * Best-effort wait until the page stops loading. Falls back to a short fixed delay when the
   * window implementation does not expose `isLoading`, so callers always get a settled-ish state.
   */
  async waitForSettle(timeoutMs = 4_000): Promise<void> {
    const contents = this.surface.webContents as unknown as { isLoading?: () => boolean };
    if (typeof contents.isLoading !== 'function') {
      await delay(120);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    await delay(80);
    while (Date.now() < deadline) {
      if (this.isDestroyed() || !contents.isLoading()) return;
      await delay(100);
    }
  }

  private assertAlive(): void {
    if (this.isDestroyed()) throw new Error(`Browser tab ${this.id} is closed.`);
  }

  viewportRevision(): number {
    return this.surface.viewportRevision();
  }

  zoomFactor(): number {
    return this.surface.zoomFactor();
  }

  present(window: BrowserWindow, bounds: Electron.Rectangle): Electron.Rectangle | null {
    return this.surface.present(window, bounds);
  }

  park(): boolean {
    return this.surface.park();
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
