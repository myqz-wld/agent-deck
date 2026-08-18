import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import type { BrowserStateSource, BrowserViewBounds } from '@shared/browser-view';

import { FakeSession, FakeWindow } from './engine/__tests__/_fakes';
import type { EngineTabSurface } from './engine/surface';
import { BrowserEngine, setBrowserEngine } from './engine/registry';
import { acquireSessionBrowser } from './session-browser';
import { BrowserStateProjectionRegistry } from './browser-state-projection';
import { BrowserPresentationController } from './browser-presentation-controller';

class PresentableSurface implements EngineTabSurface {
  readonly window = new FakeWindow(new FakeSession());
  readonly webContents = this.window.webContents as unknown as WebContents;
  readonly present = vi.fn((_window: BrowserWindow, bounds: Electron.Rectangle) => ({ ...bounds }));
  readonly park = vi.fn(() => {
    if (this.parkViewportRevision != null) {
      this.viewportRevisionValue = this.parkViewportRevision;
      this.deviceScaleFactorValue = 1;
    }
    return true;
  });
  deviceScaleFactorValue = 1;
  viewportRevisionValue = 1;
  parkViewportRevision: number | null = null;
  private closed: (() => void) | null = null;

  isDestroyed(): boolean { return this.window.destroyed; }
  loadURL(url: string): Promise<void> { return this.window.loadURL(url).then(() => undefined); }
  requestShow(): void {}
  destroy(): void {
    this.window.destroy();
    this.closed?.();
  }
  deviceScaleFactor(): number { return this.deviceScaleFactorValue; }
  canSendInputEvents(): boolean { return false; }
  onActivated(): () => void { return () => undefined; }
  onClosed(listener: () => void): () => void {
    this.closed = listener;
    return () => { if (this.closed === listener) this.closed = null; };
  }
  viewportRevision(): number { return this.viewportRevisionValue; }
  zoomFactor(): number { return 1; }
}

const source: BrowserStateSource = { kind: 'local', sessionId: 'session-a' };
const bounds: BrowserViewBounds = { x: 12, y: 90, width: 456, height: 321 };

let registry: BrowserStateProjectionRegistry;
let surfaces: PresentableSurface[];

beforeEach(() => {
  surfaces = [];
  setBrowserEngine(new BrowserEngine({
    createSurface: () => {
      const surface = new PresentableSurface();
      surfaces.push(surface);
      return surface;
    },
  }));
  registry = new BrowserStateProjectionRegistry();
});

afterEach(() => setBrowserEngine(null));

async function setup(tabCount = 2) {
  const owner = acquireSessionBrowser('opaque-owner');
  for (let index = 0; index < tabCount; index += 1) await owner.openTab();
  const snapshot = registry.publish(source, 'opaque-owner').snapshot;
  if (snapshot == null) throw new Error('missing Browser state');
  const window = {
    isDestroyed: () => false,
    webContents: { id: 42, isDestroyed: () => false },
  } as unknown as BrowserWindow;
  const host = {
    parkAll: vi.fn(),
    updateParkingViewport: vi.fn(),
  };
  const controller = new BrowserPresentationController({
    projection: registry,
    getWindow: () => window,
    getHost: () => host,
    getOwner: () => owner,
    createLeaseId: () => 'lease-a',
  });
  return { controller, host, owner, snapshot };
}

describe('Browser presentation controller', () => {
  it('binds one renderer/window/source lease and applies responsive bounds', async () => {
    const { controller, host, owner, snapshot } = await setup();
    const lease = controller.begin(42, source, snapshot.revision);

    const result = controller.update(42, lease.leaseId, 1, bounds);

    expect(host.parkAll).toHaveBeenCalledOnce();
    expect(host.updateParkingViewport).toHaveBeenCalledWith({ width: 456, height: 321 });
    expect(surfaces[0]?.present).toHaveBeenCalledWith(expect.anything(), bounds);
    expect(owner.isActive(1)).toBe(true);
    expect(result).toMatchObject({ appliedBounds: bounds, snapshot: { source } });
    expect(JSON.stringify(lease)).not.toContain('opaque-owner');
  });

  it('rejects stale revisions, foreign renderers, and stale leases', async () => {
    const { controller, snapshot } = await setup();

    expect(() => controller.begin(42, source, snapshot.revision + 1)).toThrow(/changed/);
    const lease = controller.begin(42, source, snapshot.revision);
    expect(() => controller.update(7, lease.leaseId, 1, bounds)).toThrow(/active Agent Deck/);
    expect(() => controller.update(42, 'other-lease', 1, bounds)).toThrow(/stale/);
  });

  it('selects a fallback once and reparks when the final tab closes', async () => {
    const { controller, host, owner, snapshot } = await setup();
    const lease = controller.begin(42, source, snapshot.revision);
    controller.update(42, lease.leaseId, 2, bounds);

    const remaining = controller.close(42, lease.leaseId, 2);
    expect(remaining.snapshot?.tabs).toEqual([
      expect.objectContaining({ id: 1, active: true }),
    ]);
    expect(owner.isActive(1)).toBe(true);

    const closed = controller.close(42, lease.leaseId, 1);
    expect(closed.snapshot).toBeNull();
    expect(host.parkAll).toHaveBeenCalledTimes(2);
    expect(() => controller.update(42, lease.leaseId, 1, bounds)).toThrow(/stale/);
  });

  it('revokes a presentation when its source is cleared externally', async () => {
    const { controller, host, snapshot } = await setup(1);
    const lease = controller.begin(42, source, snapshot.revision);
    controller.observeProjection(registry.clear(source));

    expect(host.parkAll).toHaveBeenCalledTimes(2);
    expect(controller.park(42, lease.leaseId)).toBe(false);
  });

  it('freezes a credential-stripped viewport PNG and parks the native view', async () => {
    const { controller, snapshot } = await setup(1);
    const lease = controller.begin(42, source, snapshot.revision);
    controller.update(42, lease.leaseId, 1, bounds);
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
    png.writeUInt32BE(912, 16);
    png.writeUInt32BE(642, 20);
    const surface = surfaces[0]!;
    surface.deviceScaleFactorValue = 2;
    surface.parkViewportRevision = 2;
    surface.window.url = 'https://user:secret@example.test/path?q=1';
    surface.window.jsHandler = () => ({
      scrollX: 12, scrollY: 34, width: 456, height: 321,
    });
    surface.window.webContents.capturePage.mockResolvedValue({
      toPNG: () => png,
      getSize: () => ({ width: 912, height: 642 }),
      resize: () => ({ toPNG: () => png }),
    });

    const capture = await controller.captureAnnotation(42, lease.leaseId, 1);

    expect(capture).toMatchObject({
      protocolVersion: 1,
      source,
      tabId: 1,
      url: 'https://example.test/path?q=1',
      viewportRevision: 2,
      presentationBounds: bounds,
      cssViewport: { width: 456, height: 321 },
      physicalPixels: { width: 912, height: 642 },
      scroll: { x: 12, y: 34 },
      deviceScaleFactor: 2,
      zoomFactor: 1,
      pngBase64: png.toString('base64'),
    });
    expect(surface.park).toHaveBeenCalledOnce();
    expect(capture.snapshot.tabs[0]?.viewportRevision).toBe(capture.viewportRevision);
    expect(JSON.stringify(capture)).not.toContain('secret');
    expect(JSON.stringify(capture)).not.toContain('opaque-owner');
  });

  it('rejects an unsafe physical canvas size before parking the live view', async () => {
    const { controller, snapshot } = await setup(1);
    const lease = controller.begin(42, source, snapshot.revision);
    controller.update(42, lease.leaseId, 1, bounds);
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
    png.writeUInt32BE(8_000, 16);
    png.writeUInt32BE(6_000, 20);
    const surface = surfaces[0]!;
    surface.window.webContents.capturePage.mockResolvedValue({
      toPNG: () => png,
      getSize: () => ({ width: 8_000, height: 6_000 }),
      resize: () => ({ toPNG: () => png }),
    });

    await expect(controller.captureAnnotation(42, lease.leaseId, 1))
      .rejects.toThrow(/safe canvas limit/);
    expect(surface.park).not.toHaveBeenCalled();
  });
});
