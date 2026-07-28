import { describe, expect, it, vi } from 'vitest';

import { BrowserEngine, ownerPartition } from '../registry';
import { BrowserTabLimitError } from '../types';

import { fakeWindowFactory } from './_fakes';

describe('BrowserEngine ownership', () => {
  it('isolates owners by partition and never crosses namespaces', () => {
    const sessionPartition = ownerPartition({ kind: 'session', id: 'sid-1' });
    const pipePartition = ownerPartition({ kind: 'codex-pipe', id: 'sid-1' });

    expect(sessionPartition).toMatch(/^agent-deck-browser-[a-f0-9]{20}$/);
    expect(pipePartition).toMatch(/^agent-deck-browser-[a-f0-9]{20}$/);
    // Same raw id, different front: storage, cookies, and auth state must not be shared.
    expect(sessionPartition).not.toBe(pipePartition);
  });

  it('returns the same handle for one owner and separate handles per owner', () => {
    const engine = new BrowserEngine(fakeWindowFactory());
    const first = engine.acquire({ kind: 'session', id: 'sid-1' });

    expect(engine.acquire({ kind: 'session', id: 'sid-1' })).toBe(first);
    expect(engine.acquire({ kind: 'session', id: 'sid-2' })).not.toBe(first);
  });

  it('keeps tab ids per owner and tracks the active tab', async () => {
    const engine = new BrowserEngine(fakeWindowFactory());
    const alice = engine.acquire({ kind: 'session', id: 'alice' });
    const bob = engine.acquire({ kind: 'session', id: 'bob' });

    const aliceFirst = await alice.openTab();
    const aliceSecond = await alice.openTab();
    const bobFirst = await bob.openTab();

    expect([aliceFirst.id, aliceSecond.id]).toEqual([1, 2]);
    expect(bobFirst.id).toBe(1);
    expect(alice.listTabInfos().map((tab) => [tab.id, tab.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(bob.listTabs()).toHaveLength(1);
  });

  it('reuses the current tab through ensureTab and only creates one on demand', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const handle = engine.acquire({ kind: 'session', id: 'sid-1' });

    const created = await handle.ensureTab();
    const reused = await handle.ensureTab();

    expect(reused).toBe(created);
    expect(factory.windows).toHaveLength(1);
  });

  it('hides windows by default and shows them only when asked', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const handle = engine.acquire({ kind: 'session', id: 'sid-1' });

    await handle.openTab();
    expect(factory.windows[0]?.shown).toBe(false);

    await handle.openTab({ show: true });
    expect(factory.windows[1]?.shown).toBe(true);
    expect(factory.windows[1]?.focused).toBe(true);
  });

  it('installs one deny-by-default permission policy per owner partition', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const handle = engine.acquire({ kind: 'session', id: 'sid-permissions' });

    await handle.openTab();
    await handle.openTab();

    const browserSession = factory.sessions.get(handle.partition);
    expect(browserSession).toBeDefined();
    expect(browserSession?.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(browserSession?.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(browserSession?.setDevicePermissionHandler).toHaveBeenCalledOnce();
    expect(browserSession?.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();

    const check = browserSession?.setPermissionCheckHandler.mock.calls[0]?.[0] as
      | (() => boolean)
      | undefined;
    expect(check?.()).toBe(false);

    const request = browserSession?.setPermissionRequestHandler.mock.calls[0]?.[0] as
      | ((_contents: unknown, _permission: string, callback: (allowed: boolean) => void) => void)
      | undefined;
    const permissionCallback = vi.fn();
    request?.(null, 'media', permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const device = browserSession?.setDevicePermissionHandler.mock.calls[0]?.[0] as
      | (() => boolean)
      | undefined;
    expect(device?.()).toBe(false);

    const display = browserSession?.setDisplayMediaRequestHandler.mock.calls[0]?.[0] as
      | ((_request: unknown, callback: (streams: object) => void) => void)
      | undefined;
    const displayCallback = vi.fn();
    display?.({}, displayCallback);
    expect(displayCallback).toHaveBeenCalledWith({});
  });

  it('enforces the per-owner tab cap', async () => {
    const engine = new BrowserEngine({ ...fakeWindowFactory(), maxTabsPerOwner: 2 });
    const handle = engine.acquire({ kind: 'session', id: 'sid-1' });
    await handle.openTab();
    await handle.openTab();

    await expect(handle.openTab()).rejects.toThrow(BrowserTabLimitError);
  });

  it('enforces the global tab cap across owners', async () => {
    const engine = new BrowserEngine({ ...fakeWindowFactory(), maxTotalTabs: 2 });
    await engine.acquire({ kind: 'session', id: 'sid-1' }).openTab();
    await engine.acquire({ kind: 'codex-pipe', id: 'codex-1' }).openTab();

    await expect(engine.acquire({ kind: 'session', id: 'sid-2' }).openTab()).rejects.toThrow(
      /global limit/,
    );
  });

  it('forgets tabs closed from the window side', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const handle = engine.acquire({ kind: 'session', id: 'sid-1' });
    await handle.openTab();

    factory.windows[0]?.close();

    expect(handle.listTabs()).toHaveLength(0);
    expect(handle.activeTab()).toBeNull();
  });

  it('closes only the tabs kept out of keepOnly', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const handle = engine.acquire({ kind: 'session', id: 'sid-1' });
    const keep = await handle.openTab();
    await handle.openTab();

    handle.keepOnly([keep.id]);

    expect(handle.listTabs().map((tab) => tab.id)).toEqual([keep.id]);
    expect(factory.windows[1]?.destroyed).toBe(true);
  });

  it('force-closes automation tabs even when a page would cancel close()', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const handle = engine.acquire({ kind: 'session', id: 'sid-beforeunload' });
    const tab = await handle.openTab();
    const window = factory.windows[0];
    if (window == null) throw new Error('expected a fake window');
    window.cancelClose = true;

    handle.closeTab(tab.id);

    expect(window.close).not.toHaveBeenCalled();
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(handle.listTabs()).toEqual([]);
  });
});

describe('BrowserEngine disposal', () => {
  it('keeps a leased owner alive until the final connection releases it', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const owner = { kind: 'codex-pipe', id: 'codex-shared' } as const;
    const first = engine.acquireLease(owner);
    const second = engine.acquireLease(owner);
    await first.handle.openTab();

    expect(second.handle).toBe(first.handle);
    await first.release();
    expect(factory.windows[0]?.destroyed).toBe(false);
    expect(engine.peek(owner)).toBe(second.handle);

    await second.release();
    expect(factory.windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(engine.peek(owner)).toBeNull();

    await second.release();
    expect(factory.windows[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('fences old leases when lifecycle force-disposes an owner', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    const owner = { kind: 'codex-pipe', id: 'codex-fenced' } as const;
    const stale = engine.acquireLease(owner);
    await stale.handle.openTab();

    await engine.disposeOwner(owner);
    expect(stale.handle.isDisposed).toBe(true);
    expect(factory.windows[0]?.destroy).toHaveBeenCalledOnce();

    const replacement = engine.acquireLease(owner);
    await replacement.handle.openTab();
    await stale.release();
    expect(factory.windows[1]?.destroyed).toBe(false);
    expect(engine.peek(owner)).toBe(replacement.handle);

    await replacement.release();
    expect(factory.windows[1]?.destroy).toHaveBeenCalledOnce();
  });

  it('disposes one owner without touching another and stays idempotent', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    await engine.acquire({ kind: 'session', id: 'alice' }).openTab();
    await engine.acquire({ kind: 'session', id: 'bob' }).openTab();

    await engine.disposeOwner({ kind: 'session', id: 'alice' });

    expect(factory.windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(factory.windows[1]?.destroyed).toBe(false);

    await engine.disposeOwner({ kind: 'session', id: 'alice' });
    expect(factory.windows[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('disposes every owner on shutdown', async () => {
    const factory = fakeWindowFactory();
    const engine = new BrowserEngine(factory);
    await engine.acquire({ kind: 'session', id: 'alice' }).openTab();
    await engine.acquire({ kind: 'codex-pipe', id: 'codex-1' }).openTab();

    await engine.disposeAll();

    expect(factory.windows.every((window) => window.destroyed)).toBe(true);
    expect(engine.totalTabs()).toBe(0);
  });

  it('refuses to open tabs after the owner was disposed', async () => {
    const engine = new BrowserEngine(fakeWindowFactory());
    const handle = engine.acquire({ kind: 'session', id: 'sid-1' });
    await handle.dispose();

    await expect(handle.openTab()).rejects.toThrow('This browser session is closed.');
    // A later acquire must hand out a fresh handle rather than the disposed one.
    expect(engine.acquire({ kind: 'session', id: 'sid-1' })).not.toBe(handle);
  });
});
