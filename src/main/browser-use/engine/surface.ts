import type { BrowserWindow, WebContents } from 'electron';

export interface BrowserTabShowTarget {
  readonly ownerId: string;
  readonly tabId: number;
}

export interface EngineTabSurface {
  readonly webContents: WebContents;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  requestShow(target?: BrowserTabShowTarget): void | boolean | Promise<boolean>;
  destroy(): void;
  deviceScaleFactor(): number;
  canSendInputEvents(): boolean;
  onActivated(listener: () => void): () => void;
  onClosed(listener: () => void): () => void;
  viewportRevision(): number;
  zoomFactor(): number;
  present(window: BrowserWindow, bounds: Electron.Rectangle): Electron.Rectangle | null;
  park(): boolean;
}
