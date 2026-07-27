import { describe, expect, it } from 'vitest';

import * as actions from '../actions';
import { BrowserEngine } from '../registry';
import type { EngineTab } from '../tab';

import { fakeWindowFactory, type FakeWindow } from './_fakes';

async function makeTab(): Promise<{ tab: EngineTab; window: FakeWindow }> {
  const factory = fakeWindowFactory();
  const engine = new BrowserEngine(factory);
  const tab = await engine.acquire({ kind: 'session', id: 'sid-1' }).openTab();
  return { tab, window: factory.windows[0] as unknown as FakeWindow };
}

describe('normalizeUrl', () => {
  it('accepts local development targets and adds a scheme to bare hosts', () => {
    expect(actions.normalizeUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(actions.normalizeUrl('127.0.0.1:3456/health')).toBe('http://127.0.0.1:3456/health');
    expect(actions.normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(actions.normalizeUrl('file:///tmp/page.html')).toBe('file:///tmp/page.html');
  });

  it('rejects schemes that would execute code or smuggle payloads', () => {
    expect(() => actions.normalizeUrl('javascript:alert(1)')).toThrow(/Unsupported URL scheme/);
    expect(() => actions.normalizeUrl('data:text/html,<h1>x</h1>')).toThrow(/Unsupported URL scheme/);
  });
});

describe('page actions', () => {
  it('navigates and reports the settled page state', async () => {
    const { tab, window } = await makeTab();

    const page = await actions.navigate(tab, 'localhost:3000/dashboard');

    expect(window.loadURL).toHaveBeenLastCalledWith('http://localhost:3000/dashboard');
    expect(page).toEqual({ url: 'http://localhost:3000/dashboard', title: 'Test page' });
  });

  it('parses a snapshot payload into refs', async () => {
    const { tab, window } = await makeTab();
    window.jsHandler = () =>
      JSON.stringify({
        refGeneration: 3,
        url: 'http://localhost:3000/',
        title: 'Test page',
        elementCount: 1,
        truncated: false,
        elements: [{ ref: '3-1', tag: 'button', name: 'Sign in' }],
      });

    const snapshot = await actions.snapshot(tab, { includeText: true });

    expect(snapshot.refGeneration).toBe(3);
    expect(snapshot.elements[0]).toMatchObject({ ref: '3-1', name: 'Sign in' });
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.any(String),
      false,
    );
  });

  it('turns a stale reference into actionable guidance', async () => {
    const { tab, window } = await makeTab();
    window.jsHandler = () => {
      throw new Error('Error: STALE_REF');
    };

    await expect(actions.click(tab, '2-7')).rejects.toThrow(/stale/);
    await expect(actions.click(tab, '2-7')).rejects.toThrow(/fresh snapshot/);
  });

  it('explains a missing snapshot instead of leaking the page sentinel', async () => {
    const { tab, window } = await makeTab();
    window.jsHandler = () => {
      throw new Error('Error: NO_SNAPSHOT');
    };

    await expect(actions.click(tab, '1-1')).rejects.toThrow(/Take a snapshot first/);
  });

  it('sends real key events only to a focused window', async () => {
    const { tab, window } = await makeTab();
    tab.show();

    const result = await actions.press(tab, 'Enter');

    expect(result.delivery).toBe('input-event');
    expect(window.inputEvents.map((event) => event.type)).toEqual(['keyDown', 'char', 'keyUp']);
    expect(window.inputEvents[0]?.keyCode).toBe('Return');
  });

  it('falls back to the script path for a background tab instead of silently doing nothing', async () => {
    const { tab, window } = await makeTab();
    let executed = '';
    window.jsHandler = (code) => {
      executed = code;
      return JSON.stringify({ pressed: 'Enter', effect: 'submitted' });
    };

    // Electron delivers synthesized input only to a focused window, so a never-shown tab must not
    // report success without doing the work.
    const result = await actions.press(tab, 'Enter');

    expect(window.inputEvents).toHaveLength(0);
    expect(result).toMatchObject({ delivery: 'script', effect: 'submitted' });
    expect(executed).toContain('requestSubmit');
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.any(String),
      true,
    );
  });

  it('normalizes key aliases before background dispatch', async () => {
    const { tab, window } = await makeTab();
    let executed = '';
    window.jsHandler = (code) => {
      executed = code;
      return JSON.stringify({ pressed: 'Enter', effect: 'submitted' });
    };

    const result = await actions.press(tab, 'return');

    expect(result).toMatchObject({ pressed: 'Enter', effect: 'submitted' });
    expect(executed).toContain('var key = "Enter"');
  });

  it('rejects unknown keys instead of silently dropping the press', async () => {
    const { tab } = await makeTab();

    await expect(actions.press(tab, 'F13')).rejects.toThrow(/Unsupported key/);
  });

  it('captures the viewport by default and the full page through CDP', async () => {
    const { tab, window } = await makeTab();

    const viewport = await actions.screenshot(tab);
    expect(viewport.fullPage).toBe(false);
    // 1600px wide double downscaled to the requested width.
    expect((await actions.screenshot(tab, { maxWidth: 1024 })).png.toString()).toBe('resized-png');

    const full = await actions.screenshot(tab, { fullPage: true, maxWidth: 1_024 });
    expect(full).toMatchObject({ fullPage: true });
    expect(full.png.toString()).toBe('full');
    expect(
      window.browserDebugger.sent.find((entry) => entry.method === 'Page.captureScreenshot')?.params,
    ).toMatchObject({
      captureBeyondViewport: true,
      clip: { width: 1_600, height: 2_400, scale: 0.64 },
    });
  });

  it('enables capture lazily when logs are first read', async () => {
    const { tab, window } = await makeTab();
    expect(window.browserDebugger.attached).toBe(false);

    await actions.readConsole(tab, 10);

    expect(window.browserDebugger.attached).toBe(true);
    expect(window.browserDebugger.sent.map((entry) => entry.method)).toContain('Runtime.enable');
  });

  it('waits for selector states without creating element refs', async () => {
    const { tab, window } = await makeTab();
    window.jsHandler = () => JSON.stringify({ count: 2, visibleCount: 1 });

    await expect(actions.waitForSelector(tab, '.row', 'visible', 500)).resolves.toMatchObject({
      kind: 'selector',
      selector: '.row',
      count: 2,
      visibleCount: 1,
    });
    expect(window.webContents.executeJavaScript.mock.calls[0]?.[0]).toContain('walkOpenDom');
    expect(window.webContents.executeJavaScript.mock.calls[0]?.[0]).toContain(
      'el.matches(selector)',
    );
  });

  it('reports invalid selectors immediately', async () => {
    const { tab, window } = await makeTab();
    window.jsHandler = () => {
      throw new Error("Error: INVALID_SELECTOR:Failed to execute 'querySelectorAll'");
    };

    await expect(actions.waitForSelector(tab, '[[', 'attached', 500)).rejects.toThrow(
      /Invalid CSS selector/,
    );
  });

  it('bounds a selector probe even when page JavaScript never settles', async () => {
    const { tab, window } = await makeTab();
    window.jsHandler = () => new Promise<never>(() => {});
    const startedAt = Date.now();

    await expect(actions.waitForSelector(tab, '.stuck', 'visible', 30)).rejects.toThrow(
      /Timed out after 30ms/,
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('waits for the configured network quiet window after requests finish', async () => {
    const { tab, window } = await makeTab();
    await actions.armNetworkTracking(tab);
    window.browserDebugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'slow',
      request: { method: 'GET', url: 'http://localhost/api' },
    });
    setTimeout(() => {
      window.browserDebugger.emit('message', {}, 'Network.loadingFinished', {
        requestId: 'slow',
      });
    }, 20);

    const result = await actions.waitForNetworkIdle(tab, 1_000, 100);

    expect(result).toMatchObject({ kind: 'network-idle', idleMs: 100, inFlight: 0 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it('times out while a tracked request remains in flight', async () => {
    const { tab, window } = await makeTab();
    await actions.armNetworkTracking(tab);
    window.browserDebugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'never-finishes',
      request: { method: 'GET', url: 'http://localhost/events' },
    });

    await expect(actions.waitForNetworkIdle(tab, 100, 100)).rejects.toThrow(
      /1 request\(s\) are still in flight/,
    );
  });
});
