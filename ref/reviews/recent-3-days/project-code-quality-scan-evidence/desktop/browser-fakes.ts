// Exact fake classes extracted from src/main/browser-use/view-host.test.ts
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { BrowserWindow, WebContentsView } from 'electron';
export class FakeHostWindow extends EventEmitter {
  readonly children: unknown[] = [];
  destroyed = false;
  focused = false;
  visible = false;
  readonly contentView = {
    addChildView: vi.fn((view: unknown) => this.children.push(view)),
    removeChildView: vi.fn((view: unknown) => {
      const index = this.children.indexOf(view);
      if (index >= 0) this.children.splice(index, 1);
    }),
  };
  readonly setOpacity = vi.fn();
  readonly setIgnoreMouseEvents = vi.fn();
  readonly setSkipTaskbar = vi.fn();
  readonly setFocusable = vi.fn();
  readonly setVisibleOnAllWorkspaces = vi.fn();
  readonly setHiddenInMissionControl = vi.fn();
  readonly showInactive = vi.fn(() => { this.visible = true; });
  readonly setContentSize = vi.fn();
  readonly getContentBounds = vi.fn(() => ({ x: 0, y: 0, width: 520, height: 680 }));
  readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 520, height: 680 }));
  readonly isDestroyed = vi.fn(() => this.destroyed);
  readonly isFocused = vi.fn(() => this.focused);
  readonly isVisible = vi.fn(() => this.visible);
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('closed');
  });

  asWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}

export class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly loadURL = vi.fn(async () => undefined);
  readonly isDestroyed = vi.fn(() => this.destroyed);
  readonly getZoomFactor = vi.fn(() => 1);
  readonly close = vi.fn(() => {
    this.destroyed = true;
    this.emit('destroyed');
  });
}

export class FakeView {
  readonly webContents = new FakeWebContents();
  readonly setBounds = vi.fn();
  readonly setVisible = vi.fn();

  asView(): WebContentsView {
    return this as unknown as WebContentsView;
  }
}
