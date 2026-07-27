import { EventEmitter } from 'node:events';

import type { BrowserWindow } from 'electron';
import { vi } from 'vitest';

/**
 * Window and debugger doubles for engine tests.
 *
 * They implement exactly the Electron surface the engine touches, so a missing call site shows up as
 * a test failure instead of silently passing against an over-permissive mock.
 */
export class FakeDebugger extends EventEmitter {
  attached = false;
  readonly sent: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  readonly attach = vi.fn(() => {
    this.attached = true;
  });
  readonly detach = vi.fn(() => {
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  });
  readonly isAttached = vi.fn(() => this.attached);
  readonly sendCommand = vi.fn(
    async (method: string, params: Record<string, unknown>, sessionId?: string) => {
      this.sent.push({ method, params, sessionId });
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('full').toString('base64') };
      return { method, params, sessionId };
    },
  );
}

export class FakeWindow extends EventEmitter {
  destroyed = false;
  shown = false;
  focused = false;
  url = '';
  pageTitle = 'Test page';
  loading = false;
  /** Script result seam: return a value, or throw to simulate a page-side error. */
  jsHandler: (code: string) => unknown = () => '{}';
  readonly inputEvents: Array<Record<string, unknown>> = [];
  readonly browserDebugger = new FakeDebugger();

  readonly webContents = {
    debugger: this.browserDebugger,
    getTitle: vi.fn(() => this.pageTitle),
    getURL: vi.fn(() => this.url),
    setWindowOpenHandler: vi.fn(),
    isLoading: vi.fn(() => this.loading),
    reload: vi.fn(() => {
      this.loading = false;
    }),
    executeJavaScript: vi.fn(async (code: string) => this.jsHandler(code)),
    capturePage: vi.fn(async () => ({
      toPNG: () => Buffer.from('viewport-png'),
      getSize: () => ({ width: 1600, height: 900 }),
      resize: () => ({ toPNG: () => Buffer.from('resized-png') }),
    })),
    sendInputEvent: vi.fn((event: Record<string, unknown>) => {
      this.inputEvents.push(event);
    }),
  };

  readonly loadURL = vi.fn(async (url: string) => {
    this.url = url;
  });
  readonly show = vi.fn(() => {
    this.shown = true;
  });
  readonly focus = vi.fn(() => {
    this.focused = true;
    this.emit('focus');
  });
  readonly isDestroyed = vi.fn(() => this.destroyed);
  readonly isVisible = vi.fn(() => this.shown && !this.destroyed);
  readonly isFocused = vi.fn(() => this.focused && !this.destroyed);
  readonly close = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  });
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  });

  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}

/** Window factory that records every created window. */
export function fakeWindowFactory(): {
  windows: FakeWindow[];
  createWindow: (options: unknown) => BrowserWindow;
  optionsSeen: unknown[];
} {
  const windows: FakeWindow[] = [];
  const optionsSeen: unknown[] = [];
  return {
    windows,
    optionsSeen,
    createWindow: (options: unknown) => {
      optionsSeen.push(options);
      const window = new FakeWindow();
      windows.push(window);
      return window.asBrowserWindow();
    },
  };
}
