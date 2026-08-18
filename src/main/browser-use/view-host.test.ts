import { EventEmitter } from 'node:events';

import type { BrowserWindow, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { BrowserViewHost } from './view-host';

class FakeHostWindow extends EventEmitter {
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

class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly loadURL = vi.fn(async () => undefined);
  readonly isDestroyed = vi.fn(() => this.destroyed);
  readonly getZoomFactor = vi.fn(() => 1);
  readonly close = vi.fn(() => {
    this.destroyed = true;
    this.emit('destroyed');
  });
}

class FakeView {
  readonly webContents = new FakeWebContents();
  readonly setBounds = vi.fn();
  readonly setVisible = vi.fn();

  asView(): WebContentsView {
    return this as unknown as WebContentsView;
  }
}

describe('Electron Browser WebContentsView host', () => {
  it('creates an opacity-zero inactive parking window and never focuses it', () => {
    const parking = new FakeHostWindow();
    let options: Electron.BrowserWindowConstructorOptions | null = null;
    const host = new BrowserViewHost({
      createParkingWindow: (input) => {
        options = input;
        return parking.asWindow();
      },
      createView: () => new FakeView().asView(),
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      displayScaleFactor: () => 1,
    });

    expect(options).toMatchObject({
      opacity: 0,
      focusable: false,
      skipTaskbar: true,
      show: false,
    });
    expect(parking.showInactive).toHaveBeenCalledOnce();
    expect(parking.focused).toBe(false);
    expect(parking.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    host.dispose();
  });

  it('creates hardened views, presents one, and reparks it when the target closes', async () => {
    const parking = new FakeHostWindow();
    const target = new FakeHostWindow();
    target.visible = true;
    target.focused = true;
    const created: FakeView[] = [];
    let viewOptions: Electron.WebContentsViewConstructorOptions | null = null;
    const showRequested = vi.fn();
    const host = new BrowserViewHost({
      createParkingWindow: () => parking.asWindow(),
      createView: (input) => {
        viewOptions = input;
        const view = new FakeView();
        created.push(view);
        return view.asView();
      },
      onShowRequested: showRequested,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      displayScaleFactor: () => 1,
    });
    const surface = host.createSurface({ partition: 'persist:test', title: 'Test' });

    expect(viewOptions).toMatchObject({
      webPreferences: {
        partition: 'persist:test',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    expect(created[0]?.setVisible).toHaveBeenCalledWith(true);
    await surface.loadURL('about:blank');
    surface.requestShow();
    expect(showRequested).toHaveBeenCalledWith(surface);
    expect(surface.present(target.asWindow(), {
      x: 10, y: 100, width: 480, height: 500,
    })).toEqual({ x: 10, y: 100, width: 480, height: 500 });
    expect(surface.canSendInputEvents()).toBe(true);

    target.emit('closed');
    expect(parking.children).toContain(created[0]);
    expect(surface.canSendInputEvents()).toBe(false);
    expect(created[0]?.setVisible).not.toHaveBeenCalledWith(false);
    surface.destroy();
    expect(created[0]?.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    host.dispose();
  });
});
