import { EventEmitter } from 'node:events';

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { CodexPipeBrowserFront } from '../fronts/codex-pipe';

class FakeDebugger extends EventEmitter {
  attached = false;
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
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Target.attachToTarget') return { sessionId: 'child-session' };
      return { method, params, sessionId };
    },
  );
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  shown = false;
  focused = false;
  url = '';
  readonly browserDebugger = new FakeDebugger();
  readonly webContents = {
    debugger: this.browserDebugger,
    getTitle: vi.fn(() => 'Test page'),
    getURL: vi.fn(() => this.url),
    setWindowOpenHandler: vi.fn(),
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
}

describe('CodexPipeBrowserFront', () => {
  it('binds metadata to the first real Codex session and rejects connection reuse', async () => {
    const session = new CodexPipeBrowserFront({ notify: vi.fn() }, { appVersion: '1.2.3' });

    await expect(
      session.handleRequest('getInfo', {
        session_id: 'codex-session-a',
        turn_id: 'turn-1',
      }),
    ).resolves.toMatchObject({
      name: 'Agent Deck In-app Browser',
      version: '1.2.3',
      type: 'iab',
      metadata: {
        codexAppBuildFlavor: 'prod',
        codexSessionId: 'codex-session-a',
        agentDeckSessionOwned: 'true',
      },
    });
    await expect(
      session.handleRequest('getTabs', {
        session_id: 'codex-session-b',
        turn_id: 'turn-2',
      }),
    ).rejects.toThrow('Browser-use connection cannot switch Codex sessions.');
  });

  it('creates an isolated window and forwards CDP commands and events', async () => {
    const notifier = { notify: vi.fn() };
    const windows: FakeWindow[] = [];
    const optionsSeen: BrowserWindowConstructorOptions[] = [];
    const session = new CodexPipeBrowserFront(notifier, {
      appVersion: '1.2.3',
      showWindows: true,
      createWindow: (options) => {
        optionsSeen.push(options);
        const window = new FakeWindow();
        windows.push(window);
        return window as unknown as BrowserWindow;
      },
    });
    const params = { session_id: 'codex-session-a', turn_id: 'turn-1' };

    const created = await session.handleRequest('createTab', params);
    expect(created).toEqual({
      id: 1,
      title: 'Test page',
      url: 'about:blank',
      active: true,
    });
    expect(optionsSeen[0]?.webPreferences).toMatchObject({
      partition: expect.stringMatching(/^agent-deck-browser-[a-f0-9]{20}$/),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(windows[0]?.shown).toBe(true);
    expect(windows[0]?.focused).toBe(true);

    await expect(
      session.handleRequest('executeCdp', {
        ...params,
        target: { tabId: 1 },
        method: 'Page.navigate',
        commandParams: { url: 'http://127.0.0.1:3456' },
      }),
    ).resolves.toEqual({
      method: 'Page.navigate',
      params: { url: 'http://127.0.0.1:3456' },
      sessionId: undefined,
    });
    expect(windows[0]?.browserDebugger.attach).toHaveBeenCalledWith('1.3');

    windows[0]?.browserDebugger.emit(
      'message',
      {},
      'Page.loadEventFired',
      { timestamp: 12 },
      '',
    );
    expect(notifier.notify).toHaveBeenCalledWith('onCDPEvent', {
      source: { tabId: 1 },
      method: 'Page.loadEventFired',
      params: { timestamp: 12 },
    });
  });

  it('tracks child target sessions and destroys every owned window on dispose', async () => {
    const window = new FakeWindow();
    const session = new CodexPipeBrowserFront(
      { notify: vi.fn() },
      {
        appVersion: '1.2.3',
        showWindows: false,
        createWindow: () => window as unknown as BrowserWindow,
      },
    );
    const params = { session_id: 'codex-session-a', turn_id: 'turn-1' };
    await session.handleRequest('createTab', params);

    await session.handleRequest('attachTarget', {
      ...params,
      tabId: 1,
      targetId: 'iframe-target',
    });
    await session.handleRequest('executeCdp', {
      ...params,
      target: { tabId: 1, targetId: 'iframe-target' },
      method: 'Runtime.evaluate',
      commandParams: { expression: 'document.title' },
    });
    expect(window.browserDebugger.sendCommand).toHaveBeenLastCalledWith(
      'Runtime.evaluate',
      { expression: 'document.title' },
      'child-session',
    );

    await session.dispose();
    expect(window.destroy).toHaveBeenCalledOnce();
    await session.dispose();
    expect(window.destroy).toHaveBeenCalledOnce();
  });
});
