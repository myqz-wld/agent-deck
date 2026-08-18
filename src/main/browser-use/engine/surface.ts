import { screen, type BrowserWindow, type WebContents } from 'electron';

export interface EngineTabSurface {
  readonly webContents: WebContents;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  requestShow(): void;
  destroy(): void;
  deviceScaleFactor(): number;
  canSendInputEvents(): boolean;
  onActivated(listener: () => void): () => void;
  onClosed(listener: () => void): () => void;
  viewportRevision(): number;
  present(window: BrowserWindow, bounds: Electron.Rectangle): Electron.Rectangle | null;
  park(): boolean;
}

/** Compatibility surface for injected BrowserWindow tests and the legacy Codex fixture. */
export class BrowserWindowTabSurface implements EngineTabSurface {
  readonly webContents: WebContents;

  constructor(private readonly window: BrowserWindow) {
    this.webContents = window.webContents;
  }

  isDestroyed(): boolean {
    return this.window.isDestroyed();
  }

  loadURL(url: string): Promise<void> {
    return this.window.loadURL(url).then(() => undefined);
  }

  requestShow(): void {
    if (this.isDestroyed()) return;
    this.window.show();
    this.window.focus();
  }

  destroy(): void {
    if (!this.isDestroyed()) this.window.destroy();
  }

  deviceScaleFactor(): number {
    const window = this.window as BrowserWindow & {
      getBounds?: () => Electron.Rectangle;
    };
    if (typeof window.getBounds !== 'function') return 1;
    const value = screen.getDisplayMatching(window.getBounds()).scaleFactor;
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  canSendInputEvents(): boolean {
    if (this.isDestroyed()) return false;
    return this.window.isVisible() && this.window.isFocused();
  }

  onActivated(listener: () => void): () => void {
    this.window.on('focus', listener);
    return () => this.window.removeListener('focus', listener);
  }

  onClosed(listener: () => void): () => void {
    this.window.on('closed', listener);
    return () => this.window.removeListener('closed', listener);
  }

  viewportRevision(): number {
    return 1;
  }

  present(_window: BrowserWindow, _bounds: Electron.Rectangle): Electron.Rectangle | null {
    return null;
  }

  park(): boolean {
    return false;
  }
}
