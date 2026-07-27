/**
 * Real-Electron browser-engine boundary fixture.
 *
 * This intentionally exercises behavior that the strict BrowserWindow double cannot prove:
 * Electron permission defaults, user activation, beforeunload cancellation, hidden-window key
 * behavior, selector wall-clock bounds, and CDP screenshot dimensions.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { app, BrowserWindow, nativeImage } from 'electron';

import {
  click,
  press,
  screenshot,
  snapshot,
  waitForSelector,
} from '../../src/main/browser-use/engine/actions';
import {
  buildTabWindowOptions,
  EngineTab,
} from '../../src/main/browser-use/engine/tab';

interface RealTab {
  tab: EngineTab;
  window: BrowserWindow;
}

const windows = new Set<BrowserWindow>();
const partition = `agent-deck-browser-fixture-${process.pid}`;

function createTab(): RealTab {
  const window = new BrowserWindow(buildTabWindowOptions(partition, 'Browser fixture'));
  windows.add(window);
  window.on('closed', () => windows.delete(window));
  const tab = new EngineTab({
    id: windows.size,
    window,
    onActivated: () => {},
    onClosed: () => {},
  });
  return { tab, window };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('fixture server has no port');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error == null ? resolve() : reject(error)));
  });
}

async function main(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <style>body { min-width: 1600px; min-height: 2600px; }</style>
      <button id="action">Action</button>
      <dialog id="dialog"><button id="dialog-button">Inside dialog</button></dialog>
      <form id="form"><input id="input" value="abcd"><textarea id="textarea"></textarea></form>
      <select id="select"><option>one</option><option>two</option></select>
      <script>
        window.__activationReads = [];
        window.__clickActivation = null;
        const originalMatches = Element.prototype.matches;
        Element.prototype.matches = function (...args) {
          window.__activationReads.push(navigator.userActivation.isActive);
          return originalMatches.apply(this, args);
        };
        document.querySelector('#action').addEventListener('click', () => {
          window.__clickActivation = navigator.userActivation.isActive;
        });
      </script>`);
  });

  const port = await listen(server);
  await app.whenReady();
  try {
    const primary = createTab();
    await primary.tab.loadUrl(`http://127.0.0.1:${port}/`);

    const notificationPermission = await primary.tab.executeJs<string>(
      'Notification.requestPermission()',
    );
    assert.equal(notificationPermission, 'denied', 'remote notification permission must be denied');
    const geolocationPermission = await primary.tab.executeJs<string>(
      "navigator.permissions.query({ name: 'geolocation' }).then((result) => result.state)",
    );
    assert.equal(
      geolocationPermission,
      'denied',
      'remote geolocation permission checks must be denied',
    );

    const snap = await snapshot(primary.tab);
    await waitForSelector(primary.tab, '#action', 'visible', 1_000);
    const activationReads = await primary.tab.executeJs<boolean[]>(
      'window.__activationReads.slice()',
    );
    assert.ok(activationReads.length > 0, 'snapshot/wait should evaluate element matches');
    assert.ok(
      activationReads.every((active) => active === false),
      'snapshot/wait must not receive synthetic user activation',
    );

    const actionRef = String(
      snap.elements.find((element) => element.name === 'Action')?.ref ?? '',
    );
    assert.notEqual(actionRef, '', 'fixture action must receive a snapshot ref');
    await click(primary.tab, actionRef);
    assert.equal(
      await primary.tab.executeJs<boolean>('window.__clickActivation'),
      true,
      'an explicit click may receive user activation',
    );

    await primary.tab.executeJs(
      "document.querySelector('#input').focus(); document.querySelector('#input').setSelectionRange(2, 2)",
    );
    await press(primary.tab, 'backspace');
    assert.equal(
      await primary.tab.executeJs<string>("document.querySelector('#input').value"),
      'acd',
      'hidden-window Backspace must edit the focused input',
    );

    await primary.tab.executeJs("document.querySelector('#textarea').focus()");
    await press(primary.tab, 'return');
    assert.equal(
      await primary.tab.executeJs<string>("document.querySelector('#textarea').value"),
      '\n',
      'hidden-window Return must insert a textarea newline',
    );

    await primary.tab.executeJs("document.querySelector('#select').focus()");
    await press(primary.tab, 'arrowdown');
    assert.equal(
      await primary.tab.executeJs<number>("document.querySelector('#select').selectedIndex"),
      1,
      'hidden-window ArrowDown must advance a select',
    );

    await primary.tab.executeJs(
      "document.querySelector('#dialog').showModal(); document.querySelector('#dialog-button').focus()",
    );
    await press(primary.tab, 'escape');
    assert.equal(
      await primary.tab.executeJs<boolean>("document.querySelector('#dialog').open"),
      false,
      'hidden-window Escape must dismiss a native dialog',
    );

    const capture = await screenshot(primary.tab, { fullPage: true, maxWidth: 240 });
    const captureSize = nativeImage.createFromBuffer(capture.png).getSize();
    assert.equal(capture.fullPage, true);
    assert.ok(
      captureSize.width <= 240,
      `full-page width ${captureSize.width} exceeded maxWidth 240`,
    );

    const closeFixture = createTab();
    await closeFixture.tab.loadUrl(`http://127.0.0.1:${port}/`);
    await closeFixture.tab.executeJs(
      "window.addEventListener('beforeunload', (event) => { event.returnValue = 'stay'; })",
    );
    closeFixture.tab.close();
    assert.equal(
      closeFixture.window.isDestroyed(),
      true,
      'beforeunload must not veto automation-owned tab closure',
    );

    const timeoutFixture = createTab();
    await timeoutFixture.tab.loadUrl(`http://127.0.0.1:${port}/`);
    await timeoutFixture.tab.executeJs(`(() => {
      const original = Element.prototype.matches;
      Element.prototype.matches = function (...args) {
        const deadline = Date.now() + 750;
        while (Date.now() < deadline) {}
        return original.apply(this, args);
      };
    })()`);
    const startedAt = Date.now();
    await assert.rejects(
      waitForSelector(timeoutFixture.tab, '.never', 'visible', 100),
      /Timed out after 100ms/,
    );
    assert.ok(
      Date.now() - startedAt < 500,
      'selector timeout must be a main-process wall-clock bound',
    );
    timeoutFixture.tab.destroy();
    primary.tab.destroy();

    console.log('[browser-engine-electron] all real-Electron boundary checks passed');
  } finally {
    for (const window of windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    await closeServer(server);
    app.quit();
  }
}

void main().catch((error) => {
  console.error('[browser-engine-electron] fixture failed:', error);
  for (const window of windows) {
    if (!window.isDestroyed()) window.destroy();
  }
  app.exit(1);
});
