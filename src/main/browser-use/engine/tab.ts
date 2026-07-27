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

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

import { CdpBridge } from './cdp';
import { DEFAULT_WINDOW_TITLE, INITIAL_URL, type TabInfo } from './types';

export interface EngineTabDeps {
  id: number;
  window: BrowserWindow;
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
  private readonly window: BrowserWindow;

  constructor(deps: EngineTabDeps) {
    this.id = deps.id;
    this.window = deps.window;
    this.cdp = new CdpBridge(() => this.window.webContents.debugger);

    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.on('focus', () => deps.onActivated(this.id));
    this.window.on('closed', () => deps.onClosed(this.id));
  }

  isDestroyed(): boolean {
    return this.window.isDestroyed();
  }

  info(active: boolean): TabInfo {
    const destroyed = this.isDestroyed();
    return {
      id: this.id,
      title: destroyed ? '' : this.window.webContents.getTitle(),
      url: destroyed ? '' : this.window.webContents.getURL() || INITIAL_URL,
      active,
    };
  }

  url(): string {
    return this.isDestroyed() ? '' : this.window.webContents.getURL() || INITIAL_URL;
  }

  title(): string {
    return this.isDestroyed() ? '' : this.window.webContents.getTitle();
  }

  show(): void {
    if (this.isDestroyed()) return;
    this.window.show();
    this.window.focus();
  }

  close(): void {
    if (!this.isDestroyed()) this.window.close();
  }

  destroy(): void {
    if (!this.isDestroyed()) this.window.destroy();
  }

  async loadUrl(url: string): Promise<void> {
    this.assertAlive();
    await this.window.loadURL(url);
  }

  async reload(): Promise<void> {
    this.assertAlive();
    this.window.webContents.reload();
    await this.waitForSettle();
  }

  async executeJs<T = unknown>(expression: string): Promise<T> {
    this.assertAlive();
    const contents = this.window.webContents as unknown as {
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<T>;
    };
    if (typeof contents.executeJavaScript !== 'function') {
      throw new Error('This browser tab cannot evaluate JavaScript.');
    }
    return contents.executeJavaScript(expression, true);
  }

  async capturePng(maxWidth?: number): Promise<Buffer> {
    this.assertAlive();
    const contents = this.window.webContents as unknown as {
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

  sendKey(keyCode: string): boolean {
    this.assertAlive();
    const contents = this.window.webContents as unknown as {
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
    const contents = this.window.webContents as unknown as { isLoading?: () => boolean };
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
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
