import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { BrowserWindow, WebContentsView } from 'electron';
import { FakeWindow } from '../engine/__tests__/_fakes';

export class ShowWindow extends EventEmitter {
  destroyed = false;
  visible = false;
  focused = false;
  minimized = false;
  children: unknown[] = [];
  readonly webContents = Object.assign(new EventEmitter(), {
    id: 11,
    isDestroyed: vi.fn(() => this.destroyed),
    send: vi.fn(),
  });
  contentView = {
    addChildView: vi.fn((view: unknown) => this.children.push(view)),
    removeChildView: vi.fn((view: unknown) => {
      this.children = this.children.filter((candidate) => candidate !== view);
    }),
  };
  setOpacity = vi.fn();
  setIgnoreMouseEvents = vi.fn();
  setSkipTaskbar = vi.fn();
  setFocusable = vi.fn();
  setVisibleOnAllWorkspaces = vi.fn();
  setHiddenInMissionControl = vi.fn();
  showInactive = vi.fn(() => { this.visible = true; });
  setContentSize = vi.fn();
  getContentBounds = () => ({ x: 0, y: 0, width: 520, height: 680 });
  getBounds = this.getContentBounds;
  isDestroyed = () => this.destroyed;
  isFocused = () => this.focused;
  isVisible = () => this.visible;
  isMinimized = () => this.minimized;
  restore = vi.fn(() => { this.minimized = false; });
  show = vi.fn(() => { this.visible = true; });
  focus = vi.fn(() => { this.focused = true; this.emit('focus'); });
  destroy = () => { this.destroyed = true; this.emit('closed'); };
  asWindow(): BrowserWindow { return this as unknown as BrowserWindow; }
}

export class ShowView {
  readonly webContents = Object.assign(new EventEmitter(), new FakeWindow().webContents, {
    loadURL: async () => undefined,
    close: () => { this.destroyed = true; this.webContents.emit('destroyed'); },
    isDestroyed: () => this.destroyed,
    getZoomFactor: () => 1,
  });
  destroyed = false;
  setBounds = vi.fn();
  setVisible = vi.fn();
  asView(): WebContentsView { return this as unknown as WebContentsView; }
}
