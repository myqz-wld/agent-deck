/** Verify shared website login and native persistence using only a synthetic local response. */
import assert from 'node:assert/strict';
import { session } from 'electron';

import { BrowserEngine } from '../../src/main/browser-use/engine/registry';
import type { EngineTab } from '../../src/main/browser-use/engine/tab';
import type { BrowserViewHost } from '../../src/main/browser-use/view-host';

const url = 'https://browser-login.test/';

async function assertLoggedIn(tab: EngineTab): Promise<void> {
  const state = await tab.executeJs<{ cookie: string; account: string | null }>(
    "({ cookie: document.cookie, account: localStorage.getItem('fixture-account') })",
  );
  assert.equal(state.cookie, 'fixture-login=synthetic-session');
  assert.equal(state.account, 'synthetic-account');
}

export async function verifySharedBrowserLogin(
  host: BrowserViewHost,
  restore: boolean,
): Promise<void> {
  const engine = new BrowserEngine({ createSurface: (options) => host.createSurface(options) });
  const firstOwner = { kind: 'session', id: restore ? 'after-restart' : 'first-session' } as const;
  const first = engine.acquire(firstOwner);
  const browserSession = session.fromPartition(first.partition);
  assert.equal(browserSession.isPersistent(), true, 'website data must use a persistent profile');
  browserSession.protocol.handle('https', () => new Response('<!doctype html><title>Login fixture</title>', {
    headers: { 'content-type': 'text/html' },
  }));

  try {
    const firstTab = await first.openTab();
    await firstTab.loadUrl(url);
    if (!restore) {
      assert.equal(await firstTab.executeJs('document.cookie'), '', 'fixture profile must start empty');
      await firstTab.executeJs(`
        document.cookie = 'fixture-login=synthetic-session; Max-Age=3600; Path=/; Secure; SameSite=Lax';
        localStorage.setItem('fixture-account', 'synthetic-account');
      `);
    }
    await assertLoggedIn(firstTab);

    const second = engine.acquire({ kind: 'session', id: 'another-session' });
    const secondTab = await second.openTab();
    await secondTab.loadUrl(url);
    await assertLoggedIn(secondTab);
    assert.deepEqual(first.listTabs(), [firstTab], 'each owner must list only its own tabs');
    assert.deepEqual(second.listTabs(), [secondTab]);

    await engine.disposeOwner(firstOwner);
    assert.equal(firstTab.isDestroyed(), true);
    assert.equal(secondTab.isDestroyed(), false, 'closing one session must preserve another');
    await engine.disposeAll();

    const later = engine.acquire({ kind: 'session', id: 'later-session' });
    const laterTab = await later.openTab();
    await laterTab.loadUrl(url);
    await assertLoggedIn(laterTab);
    await browserSession.cookies.flushStore();
    browserSession.flushStorageData();
    console.log(`[browser-engine-electron] shared login ${restore ? 'restored after restart' : 'reused across sessions'}`);
  } finally {
    await engine.disposeAll();
    browserSession.protocol.unhandle('https');
  }
}
