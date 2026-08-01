import { EventEmitter } from 'node:events';

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { CodexPipeBrowserFront } from '../fronts/codex-pipe';
import { FakeSession } from '../engine/__tests__/_fakes';
import { BrowserEngine } from '../engine/registry';
import type { EngineTab } from '../engine/tab';

interface InspectableTargetState {
  targetIdsBySessionId: Map<string, string>;
  targetSessionsById: Map<string, string>;
}

function targetStates(front: CodexPipeBrowserFront): Map<number, InspectableTargetState> {
  return (
    front as unknown as { targets: Map<number, InspectableTargetState> }
  ).targets;
}

function cdpSubscriptionCounts(tab: EngineTab): { detach: number; message: number } {
  const cdp = tab.cdp as unknown as {
    detachListeners: Set<unknown>;
    messageListeners: Set<unknown>;
  };
  return {
    detach: cdp.detachListeners.size,
    message: cdp.messageListeners.size,
  };
}

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
  readonly browserSession = new FakeSession();
  readonly webContents = {
    debugger: this.browserDebugger,
    session: this.browserSession.asSession(),
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

  it('releases target metadata and subscriptions across attach-close-create churn', async () => {
    const windows: FakeWindow[] = [];
    const engine = new BrowserEngine({
      createWindow: () => {
        const window = new FakeWindow();
        windows.push(window);
        return window as unknown as BrowserWindow;
      },
    });
    const session = new CodexPipeBrowserFront(
      { notify: vi.fn() },
      { appVersion: '1.2.3', engine, showWindows: false },
    );
    const params = { session_id: 'codex-churn', turn_id: 'turn-1' };
    const owner = { kind: 'codex-pipe', id: params.session_id } as const;

    const createAttached = async (): Promise<{
      handle: NonNullable<ReturnType<BrowserEngine['peek']>>;
      tab: EngineTab;
      tabId: number;
      window: FakeWindow;
    }> => {
      const created = await session.handleRequest('createTab', params) as { id: number };
      await session.handleRequest('attachTarget', {
        ...params,
        tabId: created.id,
        targetId: `iframe-${created.id}`,
      });
      const handle = engine.peek(owner);
      const window = windows.at(-1);
      if (handle == null || window == null) throw new Error('expected a live browser tab');
      const tab = handle.requireTab(created.id);
      const state = targetStates(session).get(created.id);
      expect(state?.targetIdsBySessionId.size).toBe(1);
      expect(state?.targetSessionsById.size).toBe(1);
      expect(cdpSubscriptionCounts(tab)).toEqual({ detach: 1, message: 1 });
      expect(targetStates(session).size).toBe(1);
      return { handle, tab, tabId: created.id, window };
    };
    const expectReleased = (tabId: number, tab: EngineTab): void => {
      expect(targetStates(session).has(tabId)).toBe(false);
      expect(cdpSubscriptionCounts(tab)).toEqual({ detach: 0, message: 0 });
    };

    const pageClosed = await createAttached();
    await session.handleRequest('executeCdp', {
      ...params,
      target: { tabId: pageClosed.tabId },
      method: 'Page.close',
    });
    await session.handleRequest('executeCdp', {
      ...params,
      target: { tabId: pageClosed.tabId },
      method: 'Page.close',
    });
    expectReleased(pageClosed.tabId, pageClosed.tab);

    const targetClosed = await createAttached();
    const targetId = `agent-deck-iab-tab:${targetClosed.tabId}`;
    await session.handleRequest('executeCdp', {
      ...params,
      method: 'Target.closeTarget',
      commandParams: { targetId },
    });
    await session.handleRequest('executeCdp', {
      ...params,
      method: 'Target.closeTarget',
      commandParams: { targetId },
    });
    expectReleased(targetClosed.tabId, targetClosed.tab);

    const finalized = await createAttached();
    await session.handleRequest('finalizeTabs', { ...params, keep: [] });
    await session.handleRequest('finalizeTabs', { ...params, keep: [] });
    expectReleased(finalized.tabId, finalized.tab);

    const registryClosed = await createAttached();
    registryClosed.handle.closeTab(registryClosed.tabId);
    registryClosed.handle.closeTab(registryClosed.tabId);
    expectReleased(registryClosed.tabId, registryClosed.tab);

    const windowClosed = await createAttached();
    windowClosed.window.close();
    windowClosed.window.close();
    expectReleased(windowClosed.tabId, windowClosed.tab);

    const disposed = await createAttached();
    await session.dispose();
    await session.dispose();
    expectReleased(disposed.tabId, disposed.tab);
    expect(targetStates(session).size).toBe(0);
  });

  it('prunes stale targets when listing and finalizing without masking live close errors', async () => {
    const windows: FakeWindow[] = [];
    const engine = new BrowserEngine({
      createWindow: () => {
        const window = new FakeWindow();
        windows.push(window);
        return window as unknown as BrowserWindow;
      },
    });
    const session = new CodexPipeBrowserFront(
      { notify: vi.fn() },
      { appVersion: '1.2.3', engine, showWindows: false },
    );
    const params = { session_id: 'codex-prune', turn_id: 'turn-1' };
    const owner = { kind: 'codex-pipe', id: params.session_id } as const;

    const createAttached = async (): Promise<{ tab: EngineTab; tabId: number; window: FakeWindow }> => {
      const created = await session.handleRequest('createTab', params) as { id: number };
      await session.handleRequest('attach', { ...params, tabId: created.id });
      const handle = engine.peek(owner);
      const window = windows.at(-1);
      if (handle == null || window == null) throw new Error('expected a live browser tab');
      return { tab: handle.requireTab(created.id), tabId: created.id, window };
    };

    const staleOnList = await createAttached();
    const liveOnList = await createAttached();
    staleOnList.window.destroyed = true;
    await expect(
      session.handleRequest('executeCdp', {
        ...params,
        target: { tabId: liveOnList.tabId },
        method: 'Target.getTargets',
      }),
    ).resolves.toEqual({
      targetInfos: [expect.objectContaining({ targetId: `agent-deck-iab-tab:${liveOnList.tabId}` })],
    });
    expect([...targetStates(session).keys()]).toEqual([liveOnList.tabId]);
    expect(cdpSubscriptionCounts(staleOnList.tab)).toEqual({ detach: 0, message: 0 });
    await session.handleRequest('executeCdp', {
      ...params,
      target: { tabId: liveOnList.tabId },
      method: 'Page.close',
    });

    const staleOnFinalize = await createAttached();
    staleOnFinalize.window.destroyed = true;
    await expect(
      session.handleRequest('finalizeTabs', { ...params, keep: [staleOnFinalize.tabId] }),
    ).resolves.toEqual({});
    expect(targetStates(session).size).toBe(0);
    expect(cdpSubscriptionCounts(staleOnFinalize.tab)).toEqual({ detach: 0, message: 0 });

    const liveFailure = await createAttached();
    liveFailure.window.destroy.mockImplementationOnce(() => {
      throw new Error('live close failed');
    });
    await expect(
      session.handleRequest('finalizeTabs', { ...params, keep: [] }),
    ).rejects.toThrow('live close failed');
    expect(targetStates(session).has(liveFailure.tabId)).toBe(true);
    expect(cdpSubscriptionCounts(liveFailure.tab)).toEqual({ detach: 1, message: 1 });

    await session.dispose();
    expect(cdpSubscriptionCounts(liveFailure.tab)).toEqual({ detach: 0, message: 0 });
  });

  it('releases only its own lease when two connections use one claimed owner', async () => {
    const window = new FakeWindow();
    const engine = new BrowserEngine({
      createWindow: () => window as unknown as BrowserWindow,
    });
    const options = {
      appVersion: '1.2.3',
      showWindows: false,
      engine,
    };
    const firstNotify = vi.fn();
    const secondNotify = vi.fn();
    const first = new CodexPipeBrowserFront({ notify: firstNotify }, options);
    const second = new CodexPipeBrowserFront({ notify: secondNotify }, options);
    const params = { session_id: 'codex-session-shared', turn_id: 'turn-1' };

    await first.handleRequest('createTab', params);
    await expect(second.handleRequest('getTabs', params)).resolves.toHaveLength(1);
    await first.handleRequest('attach', { ...params, tabId: 1 });
    await second.handleRequest('attach', { ...params, tabId: 1 });

    await first.dispose();
    expect(window.destroyed).toBe(false);
    await expect(second.handleRequest('getTabs', params)).resolves.toHaveLength(1);
    window.browserDebugger.emit('message', {}, 'Page.loadEventFired', {}, '');
    expect(firstNotify).not.toHaveBeenCalled();
    expect(secondNotify).toHaveBeenCalledOnce();

    await second.dispose();
    expect(window.destroy).toHaveBeenCalledOnce();
  });
});
