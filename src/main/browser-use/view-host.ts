import {
  app,
  BrowserWindow,
  screen,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type WebContentsViewConstructorOptions,
} from 'electron';

import { registerWindowRole } from '../window/window-role-registry';

import type { EngineTabSurface } from './engine/surface';
import {
  BrowserViewHostCore,
  type BrowserViewBounds,
  type BrowserViewPlacementHandle,
  type BrowserViewWindowLike,
} from './view-host-core';
import { setBrowserViewPresentationLifecyclePort } from './view-presentation-lifecycle';

export interface CreateBrowserViewSurfaceOptions {
  readonly partition: string;
  readonly title: string;
}

export interface BrowserViewHostOptions {
  readonly createParkingWindow?: (
    options: BrowserWindowConstructorOptions,
  ) => BrowserWindow;
  readonly createView?: (options: WebContentsViewConstructorOptions) => WebContentsView;
  readonly onShowRequested?: (surface: EngineTabSurface) => void;
  readonly workArea?: Electron.Rectangle;
  readonly displayScaleFactor?: (bounds: Electron.Rectangle) => number;
}

export function buildParkingWindowOptions(
  workArea = screen.getPrimaryDisplay().workArea,
): BrowserWindowConstructorOptions {
  return {
    x: workArea.x,
    y: workArea.y,
    width: 420,
    height: 480,
    show: false,
    opacity: 0,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    webPreferences: {
      backgroundThrottling: false,
    },
  };
}

export function buildBrowserViewOptions(
  partition: string,
): WebContentsViewConstructorOptions {
  return {
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  };
}

class WebContentsViewTabSurface implements EngineTabSurface {
  readonly webContents;
  private readonly activated = new Set<() => void>();
  private readonly closed = new Set<() => void>();
  private closedDelivered = false;
  private retired = false;

  constructor(
    private readonly host: BrowserViewHost,
    view: WebContentsView,
    private readonly placement: BrowserViewPlacementHandle,
  ) {
    this.webContents = view.webContents;
    this.webContents.on('focus', () => {
      for (const listener of [...this.activated]) listener();
    });
    this.webContents.once('destroyed', () => this.deliverClosed());
  }

  isDestroyed(): boolean {
    return this.retired || this.webContents.isDestroyed();
  }

  loadURL(url: string): Promise<void> {
    return this.webContents.loadURL(url).then(() => undefined);
  }

  requestShow(): void {
    if (!this.isDestroyed()) this.host.requestShow(this);
  }

  destroy(): void {
    if (this.isDestroyed()) {
      this.placement.dispose();
      this.deliverClosed();
      return;
    }
    this.retired = true;
    this.placement.dispose();
    this.webContents.close({ waitForBeforeUnload: false });
    this.deliverClosed();
  }

  deviceScaleFactor(): number {
    const window = this.host.windowFor(this.placement);
    if (window == null || window.isDestroyed()) return 1;
    const value = this.host.scaleFactor(window.getBounds());
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  canSendInputEvents(): boolean {
    return this.placement.canSendInputEvents();
  }

  onActivated(listener: () => void): () => void {
    this.activated.add(listener);
    return () => this.activated.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    this.closed.add(listener);
    return () => this.closed.delete(listener);
  }

  viewportRevision(): number {
    const zoomFactor = this.isDestroyed() ? 1 : this.webContents.getZoomFactor();
    this.placement.updateVisualMetrics({
      deviceScaleFactor: this.deviceScaleFactor(),
      zoomFactor,
    });
    return this.placement.viewportRevision;
  }

  present(window: BrowserWindow, bounds: Electron.Rectangle): Electron.Rectangle | null {
    const applied = this.host.present(this.placement, window, bounds);
    return applied == null ? null : { ...applied };
  }

  park(): boolean {
    return this.placement.park();
  }

  private deliverClosed(): void {
    if (this.closedDelivered) return;
    this.closedDelivered = true;
    this.placement.dispose();
    for (const listener of [...this.closed]) listener();
    this.closed.clear();
    this.activated.clear();
  }
}

/** Electron owner for the opacity-zero parking window and all Browser WebContentsViews. */
export class BrowserViewHost {
  readonly parkingWindow: BrowserWindow;
  private readonly core: BrowserViewHostCore;
  private readonly createView: NonNullable<BrowserViewHostOptions['createView']>;
  private readonly surfaces = new Set<WebContentsViewTabSurface>();
  private readonly observedPresentationWindows = new WeakSet<BrowserWindow>();
  private readonly unregisterParkingRole: () => void;
  private showRequested: (surface: EngineTabSurface) => void;
  private readonly displayScaleFactor: (bounds: Electron.Rectangle) => number;

  constructor(options: BrowserViewHostOptions = {}) {
    const createParkingWindow = options.createParkingWindow ?? ((windowOptions) =>
      new BrowserWindow(windowOptions));
    this.createView = options.createView ?? ((viewOptions) => new WebContentsView(viewOptions));
    this.showRequested = options.onShowRequested ?? (() => {});
    this.displayScaleFactor = options.displayScaleFactor ?? ((bounds) =>
      screen.getDisplayMatching(bounds).scaleFactor);
    this.parkingWindow = createParkingWindow(buildParkingWindowOptions(options.workArea));
    this.unregisterParkingRole = registerWindowRole(this.parkingWindow, 'browser-parking');
    this.parkingWindow.setOpacity(0);
    this.parkingWindow.setIgnoreMouseEvents(true);
    this.parkingWindow.setSkipTaskbar(true);
    this.parkingWindow.setFocusable(false);
    this.parkingWindow.setVisibleOnAllWorkspaces(false);
    const hiddenInMissionControl = this.parkingWindow as BrowserWindow & {
      setHiddenInMissionControl?: (hidden: boolean) => void;
    };
    hiddenInMissionControl.setHiddenInMissionControl?.(true);
    this.parkingWindow.showInactive();
    this.core = new BrowserViewHostCore({
      parkingWindow: this.parkingWindow as unknown as BrowserViewWindowLike,
      initialViewport: { width: 420, height: 480 },
    });
    this.parkingWindow.once('closed', () => this.unregisterParkingRole());
  }

  createSurface(options: CreateBrowserViewSurfaceOptions): EngineTabSurface {
    const view = this.createView(buildBrowserViewOptions(options.partition));
    const placement = this.core.register(view);
    const surface = new WebContentsViewTabSurface(this, view, placement);
    this.surfaces.add(surface);
    surface.onClosed(() => this.surfaces.delete(surface));
    return surface;
  }

  setShowRequested(listener: (surface: EngineTabSurface) => void): void {
    this.showRequested = listener;
  }

  requestShow(surface: EngineTabSurface): void {
    this.showRequested(surface);
  }

  present(
    placement: BrowserViewPlacementHandle,
    window: BrowserWindow,
    bounds: BrowserViewBounds,
  ): BrowserViewBounds | null {
    if (!this.observedPresentationWindows.has(window)) {
      this.observedPresentationWindows.add(window);
      window.once('closed', () => this.core.parkAll());
    }
    const applied = this.core.present(
      placement,
      window as unknown as BrowserViewWindowLike,
      bounds,
    );
    if (applied != null) {
      placement.updateVisualMetrics({
        deviceScaleFactor: this.displayScaleFactor(window.getBounds()),
        zoomFactor: 1,
      });
    }
    return applied;
  }

  windowFor(placement: BrowserViewPlacementHandle): BrowserWindow | null {
    return this.core.windowFor(placement) as BrowserWindow | null;
  }

  scaleFactor(bounds: Electron.Rectangle): number {
    return this.displayScaleFactor(bounds);
  }

  parkAll(): void {
    this.core.parkAll();
  }

  updateParkingViewport(size: { width: number; height: number }): void {
    const bounded = {
      width: Math.max(1, Math.trunc(size.width)),
      height: Math.max(1, Math.trunc(size.height)),
    };
    if (!this.parkingWindow.isDestroyed()) {
      this.parkingWindow.setContentSize(bounded.width, bounded.height);
    }
    this.core.updateParkingViewport(bounded);
  }

  dispose(): void {
    for (const surface of [...this.surfaces]) surface.destroy();
    this.surfaces.clear();
    this.unregisterParkingRole();
    if (!this.parkingWindow.isDestroyed()) this.parkingWindow.destroy();
    if (sharedHost === this) {
      sharedHost = null;
      setBrowserViewPresentationLifecyclePort(null);
    }
  }
}

let sharedHost: BrowserViewHost | null = null;

export function initializeBrowserViewHost(options: BrowserViewHostOptions = {}): BrowserViewHost {
  sharedHost?.dispose();
  sharedHost = new BrowserViewHost(options);
  setBrowserViewPresentationLifecyclePort({ parkAll: () => sharedHost?.parkAll() });
  return sharedHost;
}

export function getBrowserViewHost(): BrowserViewHost {
  if (sharedHost == null) {
    if (!app.isReady()) throw new Error('Browser view host is not initialized.');
    sharedHost = new BrowserViewHost();
  }
  return sharedHost;
}

export function setBrowserViewHost(host: BrowserViewHost | null): void {
  sharedHost = host;
  setBrowserViewPresentationLifecyclePort(
    host == null ? null : { parkAll: () => host.parkAll() },
  );
}
