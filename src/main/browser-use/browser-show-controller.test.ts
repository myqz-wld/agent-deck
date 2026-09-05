import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserShowRequest } from '@shared/browser-view';
import { BrowserEngine, setBrowserEngine } from './engine/registry';
import { BrowserViewHost } from './view-host';
import { BrowserShowController } from './browser-show-controller';
import { BrowserPresentationController } from './browser-presentation-controller';
import { BrowserStateProjectionRegistry, setBrowserStateProjectionRegistry } from './browser-state-projection';
import { executeBrowserOperation } from './operation-executor';
import type { BrowserTabShowTarget, EngineTabSurface } from './engine/surface';
import { ShowView, ShowWindow } from './__tests__/show-fakes';

const source = { kind: 'local' as const, sessionId: 'owner-a' };
const bounds = { x: 10, y: 100, width: 480, height: 500 };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const disposals: Array<() => void> = [];
function fixture(wired = true) {
  const parking = new ShowWindow();
  const target = new ShowWindow();
  const views: ShowView[] = [];
  const surfaces: EngineTabSurface[] = [];
  const events: Array<BrowserShowRequest | null> = [];
  let currentWindow: ShowWindow | null = target;
  let show!: BrowserShowController;
  const host = new BrowserViewHost({
    createParkingWindow: () => parking.asWindow(),
    createView: () => { const view = new ShowView(); views.push(view); return view.asView(); },
    workArea: { x: 0, y: 0, width: 1200, height: 800 }, displayScaleFactor: () => 1,
    ...(wired ? { onShowRequested: (surface: EngineTabSurface, owner?: BrowserTabShowTarget) =>
      show.request(surface, owner) } : {}),
  });
  const engine = new BrowserEngine({ createSurface: (options) => {
    const surface = host.createSurface(options);
    surfaces.push(surface);
    return surface;
  } });
  setBrowserEngine(engine);
  const projection = new BrowserStateProjectionRegistry();
  setBrowserStateProjectionRegistry(projection);
  const ensureWindow = vi.fn(() => {
    if (!currentWindow || currentWindow.destroyed) currentWindow = new ShowWindow();
    return currentWindow.asWindow();
  });
  show = new BrowserShowController({
    projection,
    getOwner: (id) => engine.peek({ kind: 'session', id }),
    getWindow: () => currentWindow?.asWindow() ?? null,
    ensureWindow,
    notify: (request) => events.push(request),
    timeoutMs: 100,
  });
  const controller = new BrowserPresentationController({
    projection, getWindow: () => currentWindow?.asWindow() ?? null, getHost: () => host,
    onPresented: (rendererId, source, tabId) => show.observePresentation(rendererId, source, tabId),
  });
  const owner = { applicationSessionId: source.sessionId,
    handle: engine.acquire({ kind: 'session', id: source.sessionId }), projectionSource: source };
  const open = (args = { show: true }) => executeBrowserOperation(owner, {
    protocolVersion: 1, operation: 'open', args,
  });
  const present = (tabId = 1) => {
    const lease = controller.begin(11, source, projection.get(source)!.revision);
    return controller.update(11, lease.leaseId, tabId, bounds);
  };
  disposals.push(() => { show.reset(); controller.reset(); host.dispose(); });
  return { parking, target, views, surfaces, events, engine, projection, show, controller, owner, open, present,
    ensureWindow, clearWindow: () => { currentWindow = null; }, window: () => currentWindow! };
}
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  setBrowserEngine(null);
  setBrowserStateProjectionRegistry(null);
  vi.useRealTimers();
});

it('keeps default open in the background and reports unwired explicit show as invisible', async () => {
  const f = fixture(false);
  expect(await f.open({ show: false })).toMatchObject({ ok: true, data: { visible: false } });
  expect(await f.open()).toMatchObject({ ok: true, data: { visible: false } });
  expect(f.parking.children).toContain(f.views[0]);
  expect(f.target.show).not.toHaveBeenCalled();
});

it('completes explicit show only after real owner-qualified IAB placement and coalesces repeats', async () => {
  const f = fixture();
  f.target.minimized = true;
  let settled = false;
  const first = f.open().then((result) => { settled = true; return result; });
  await flush();
  const repeated = f.open();
  await flush();
  expect(settled).toBe(false);
  expect(f.events.filter(Boolean)).toHaveLength(1);
  expect(f.target.restore).toHaveBeenCalledOnce();
  expect(f.target.show).toHaveBeenCalledOnce();
  expect(f.show.getPending(99)).toBeNull();
  expect(f.show.getPending(11)).toMatchObject({ source, tabId: 1 });
  f.show.observePresentation(11, { kind: 'local', sessionId: 'other' }, 1);
  f.show.observePresentation(99, source, 1);
  f.show.observePresentation(11, source, 2);
  await flush();
  expect(settled).toBe(false);
  f.present();
  expect(await first).toMatchObject({ ok: true, data: { visible: true } });
  expect(await repeated).toMatchObject({ ok: true, data: { visible: true } });
  expect(f.target.children).toContain(f.views[0]);
  expect(f.parking.children).not.toContain(f.views[0]);
  expect(f.show.getPending(11)).toBeNull();
  const again = f.open();
  await flush();
  expect(f.events.filter(Boolean)).toHaveLength(2);
  f.present();
  expect(await again).toMatchObject({ ok: true, data: { visible: true } });
});

it.each(['window', 'renderer', 'owner', 'reset'])('settles an outstanding show on %s teardown', async (cause) => {
  const f = fixture();
  const opening = f.open();
  await flush();
  if (cause === 'window') f.target.destroy();
  if (cause === 'renderer') f.target.webContents.emit('destroyed');
  if (cause === 'owner') {
    f.projection.clearOwner(source.sessionId);
    await f.owner.handle.dispose();
  }
  if (cause === 'reset') f.show.reset();
  expect(await opening).toMatchObject({ ok: true, data: { visible: false } });
  expect(f.show.getPending(11)).toBeNull();
});

it('recreates a closed host and retains a pending request for its late renderer', async () => {
  const f = fixture();
  f.clearWindow();
  const opening = f.open();
  await flush();
  expect(f.ensureWindow).toHaveBeenCalledOnce();
  expect(f.window()).not.toBe(f.target);
  expect(f.show.getPending(11)?.source).toEqual(source);
  f.present();
  expect(await opening).toMatchObject({ ok: true, data: { visible: true } });
});

it('expires a request when the hidden host cannot become visible', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.target.show.mockImplementation(() => {});
  const opening = f.open();
  await flush();
  f.present();
  expect(f.show.getPending(11)).not.toBeNull();
  await vi.advanceTimersByTimeAsync(100);
  expect(await opening).toMatchObject({ ok: true, data: { visible: false } });
});

it('rejects stale owners and Remote-only projections before touching the window', async () => {
  const f = fixture();
  await f.open({ show: false });
  f.projection.clearOwner(source.sessionId);
  f.projection.publish({ kind: 'remote', sessionId: 'remote-session', profileId: 'p', coreId: 'c',
    generation: 1 }, source.sessionId);
  const tab = f.owner.handle.requireTab(1);
  expect(await tab.show()).toBe(false);
  f.projection.publish(source, source.sessionId);
  await f.owner.handle.dispose();
  expect(await tab.show()).toBe(false);
  expect(f.ensureWindow).not.toHaveBeenCalled();
});

it('rejects a different owner even when it has the same tab id and a Local projection', async () => {
  const f = fixture();
  await f.open({ show: false });
  const other = f.engine.acquire({ kind: 'session', id: 'other' });
  await other.openTab();
  f.projection.publish({ kind: 'local', sessionId: 'other' }, 'other');
  expect(await f.show.request(f.surfaces[0]!, { ownerId: 'other', tabId: 1 })).toBe(false);
  expect(f.ensureWindow).not.toHaveBeenCalled();
});

it('supersedes an older show when a new tab requests the same single presentation surface', async () => {
  const f = fixture();
  const first = f.open();
  await flush();
  const second = executeBrowserOperation(f.owner, {
    protocolVersion: 1, operation: 'open', args: { show: true, newTab: true },
  });
  await flush();
  expect(await first).toMatchObject({ ok: true, data: { visible: false } });
  expect(f.show.getPending(11)?.tabId).toBe(2);
  f.present(2);
  expect(await second).toMatchObject({ ok: true, data: { visible: true, tabId: 2 } });
  expect(f.target.children).toEqual([f.views[1]]);
});
