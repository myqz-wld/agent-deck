import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

import type {
  BrowserAnnotationCapture,
  BrowserPresentationLease,
  BrowserPresentationResult,
  BrowserStateProjectionEvent,
  BrowserStateSnapshot,
  BrowserStateSource,
  BrowserViewBounds,
} from '@shared/browser-view';

import { getBrowserEngine, type BrowserOwnerHandle } from './engine/registry';
import {
  browserStateSourceKey,
  getBrowserStateProjectionRegistry,
  type BrowserStateProjectionRegistry,
} from './browser-state-projection';
import type { EngineTab } from './engine/tab';

interface BrowserPresentationHost {
  parkAll(): void;
  updateParkingViewport(size: { width: number; height: number }): void;
}

const MAX_ANNOTATION_CAPTURE_BYTES = 20 * 1024 * 1024;
const MAX_ANNOTATION_CAPTURE_PIXELS = 40_000_000;
const MAX_ANNOTATION_CAPTURE_ATTEMPTS = 3;

interface PageViewportState {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly width: number;
  readonly height: number;
}

interface StableAnnotationFrame {
  readonly bounds: BrowserViewBounds;
  readonly page: PageViewportState;
  readonly png: Buffer;
  readonly deviceScaleFactor: number;
  readonly zoomFactor: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sameBounds(left: BrowserViewBounds, right: BrowserViewBounds): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function samePageViewport(left: PageViewportState, right: PageViewportState): boolean {
  return left.scrollX === right.scrollX && left.scrollY === right.scrollY &&
    left.width === right.width && left.height === right.height;
}

async function readPageViewport(
  tab: EngineTab,
  fallback: BrowserViewBounds,
): Promise<PageViewportState | null> {
  try {
    const value = await tab.executeJs<Partial<PageViewportState>>(`(() => ({
      scrollX: Number(window.scrollX) || 0,
      scrollY: Number(window.scrollY) || 0,
      width: Math.max(1, Number(window.innerWidth) || 1),
      height: Math.max(1, Number(window.innerHeight) || 1)
    }))()`);
    if (value == null || typeof value !== 'object') return null;
    return {
      scrollX: finite(value.scrollX, 0),
      scrollY: finite(value.scrollY, 0),
      width: Math.max(1, finite(value.width, fallback.width)),
      height: Math.max(1, finite(value.height, fallback.height)),
    };
  } catch {
    return null;
  }
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  const signature = '89504e470d0a1a0a';
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Browser annotation capture did not produce a valid PNG.');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 32_768 || height > 32_768) {
    throw new Error('Browser annotation capture dimensions are invalid.');
  }
  if (width * height > MAX_ANNOTATION_CAPTURE_PIXELS) {
    throw new Error('Browser annotation capture dimensions exceed the safe canvas limit.');
  }
  return { width, height };
}

interface ActivePresentation {
  readonly leaseId: string;
  readonly rendererId: number;
  readonly window: BrowserWindow;
  readonly source: BrowserStateSource;
  readonly sourceKey: string;
  readonly ownerId: string;
  bounds: BrowserViewBounds | null;
}

export interface BrowserPresentationControllerOptions {
  readonly projection?: BrowserStateProjectionRegistry;
  readonly getWindow: () => BrowserWindow | null;
  readonly getHost: () => BrowserPresentationHost;
  readonly getOwner?: (ownerId: string) => BrowserOwnerHandle | null;
  readonly createLeaseId?: () => string;
}

/** Main-owned gate between renderer layout coordinates and session-private Browser views. */
export class BrowserPresentationController {
  private readonly projection: BrowserStateProjectionRegistry;
  private readonly getWindow: () => BrowserWindow | null;
  private readonly getHost: () => BrowserPresentationHost;
  private readonly getOwner: (ownerId: string) => BrowserOwnerHandle | null;
  private readonly createLeaseId: () => string;
  private active: ActivePresentation | null = null;

  constructor(options: BrowserPresentationControllerOptions) {
    this.projection = options.projection ?? getBrowserStateProjectionRegistry();
    this.getWindow = options.getWindow;
    this.getHost = options.getHost;
    this.getOwner = options.getOwner ?? ((ownerId) =>
      getBrowserEngine().peek({ kind: 'session', id: ownerId }));
    this.createLeaseId = options.createLeaseId ?? randomUUID;
  }

  get(source: BrowserStateSource): BrowserStateSnapshot | null {
    return this.projection.get(source);
  }

  begin(
    rendererId: number,
    source: BrowserStateSource,
    expectedRevision: number,
  ): BrowserPresentationLease {
    const window = this.requireRendererWindow(rendererId);
    const snapshot = this.projection.get(source);
    if (snapshot == null || snapshot.revision !== expectedRevision) {
      throw new Error('Browser state changed; refresh the IAB tab and retry.');
    }
    const ownerId = this.projection.owner(source);
    if (ownerId == null || this.getOwner(ownerId) == null) {
      throw new Error('Browser session is no longer available.');
    }
    this.revokeActive();
    const sourceCopy = Object.freeze({ ...source }) as BrowserStateSource;
    const leaseId = this.createLeaseId();
    this.active = {
      leaseId,
      rendererId,
      window,
      source: sourceCopy,
      sourceKey: browserStateSourceKey(sourceCopy),
      ownerId,
      bounds: null,
    };
    return Object.freeze({ leaseId, source: sourceCopy, snapshot });
  }

  update(
    rendererId: number,
    leaseId: string,
    tabId: number,
    bounds: BrowserViewBounds,
  ): BrowserPresentationResult {
    const presentation = this.requireActive(rendererId, leaseId);
    const handle = this.requireOwner(presentation);
    const tab = handle.requireTab(tabId);
    const host = this.getHost();
    host.updateParkingViewport({ width: bounds.width, height: bounds.height });
    handle.markActive(tabId);
    const appliedBounds = tab.present(presentation.window, bounds);
    if (appliedBounds == null) throw new Error('Browser view could not be presented.');
    presentation.bounds = { ...appliedBounds };
    const snapshot = this.projection.publish(presentation.source, presentation.ownerId).snapshot;
    return Object.freeze({ snapshot, appliedBounds: Object.freeze({ ...appliedBounds }) });
  }

  select(rendererId: number, leaseId: string, tabId: number): BrowserPresentationResult {
    const presentation = this.requireActive(rendererId, leaseId);
    const handle = this.requireOwner(presentation);
    const tab = handle.requireTab(tabId);
    handle.markActive(tabId);
    const appliedBounds = presentation.bounds == null
      ? null
      : tab.present(presentation.window, presentation.bounds);
    const snapshot = this.projection.publish(presentation.source, presentation.ownerId).snapshot;
    return Object.freeze({
      snapshot,
      appliedBounds: appliedBounds == null ? null : Object.freeze({ ...appliedBounds }),
    });
  }

  close(rendererId: number, leaseId: string, tabId: number): BrowserPresentationResult {
    const presentation = this.requireActive(rendererId, leaseId);
    const handle = this.requireOwner(presentation);
    handle.requireTab(tabId);
    handle.closeTab(tabId);
    const fallback = handle.activeTab() ?? handle.listTabs()[0] ?? null;
    if (fallback == null) {
      this.projection.publish(presentation.source, presentation.ownerId);
      this.revokeActive();
      return Object.freeze({ snapshot: null, appliedBounds: null });
    }
    handle.markActive(fallback.id);
    const appliedBounds = presentation.bounds == null
      ? null
      : fallback.present(presentation.window, presentation.bounds);
    const snapshot = this.projection.publish(presentation.source, presentation.ownerId).snapshot;
    return Object.freeze({
      snapshot,
      appliedBounds: appliedBounds == null ? null : Object.freeze({ ...appliedBounds }),
    });
  }

  async captureAnnotation(
    rendererId: number,
    leaseId: string,
    tabId: number,
  ): Promise<BrowserAnnotationCapture> {
    const presentation = this.requireActive(rendererId, leaseId);
    if (presentation.bounds == null) {
      throw new Error('Browser view must be presented before annotation starts.');
    }
    const handle = this.requireOwner(presentation);
    const tab = handle.requireTab(tabId);
    let frame: StableAnnotationFrame | null = null;
    // Renderer status/layout updates can settle while capturePage is in flight. Accept only one
    // internally stable frame; a real navigation still fails immediately and continuous viewport
    // churn remains bounded by the attempt cap.
    for (let attempt = 0; attempt < MAX_ANNOTATION_CAPTURE_ATTEMPTS; attempt += 1) {
      const currentBounds = presentation.bounds;
      if (currentBounds == null) {
        throw new Error('Browser view must be presented before annotation starts.');
      }
      const beforeBounds = { ...currentBounds };
      const beforeUrl = tab.url();
      const beforeViewportRevision = tab.viewportRevision();
      const beforePage = await readPageViewport(tab, beforeBounds);
      this.requireActive(rendererId, leaseId);
      const png = await tab.capturePng();
      this.requireActive(rendererId, leaseId);
      if (png.byteLength > MAX_ANNOTATION_CAPTURE_BYTES) {
        throw new Error('Browser annotation capture exceeds the 20MB safety limit.');
      }
      const afterPage = await readPageViewport(tab, beforeBounds);
      this.requireActive(rendererId, leaseId);
      const afterUrl = tab.url();
      const afterViewportRevision = tab.viewportRevision();
      const afterBounds = presentation.bounds;
      if (afterUrl !== beforeUrl) {
        throw new Error('Browser page changed during annotation capture; retry with a fresh view.');
      }
      const pageStable = beforePage == null || afterPage == null ||
        samePageViewport(beforePage, afterPage);
      if (
        afterBounds != null && sameBounds(beforeBounds, afterBounds) && pageStable &&
        afterViewportRevision === beforeViewportRevision
      ) {
        frame = {
          bounds: beforeBounds,
          page: afterPage ?? beforePage ?? {
            scrollX: 0,
            scrollY: 0,
            width: beforeBounds.width,
            height: beforeBounds.height,
          },
          png,
          deviceScaleFactor: tab.deviceScaleFactor(),
          zoomFactor: tab.zoomFactor(),
        };
        break;
      }
    }
    if (frame == null) {
      throw new Error('Browser page changed during annotation capture; retry with a fresh view.');
    }
    const physicalPixels = pngDimensions(frame.png);
    this.requireActive(rendererId, leaseId);
    if (!tab.park()) throw new Error('Browser view could not enter annotation mode.');
    const snapshot = this.projection.publish(presentation.source, presentation.ownerId).snapshot;
    if (snapshot == null) throw new Error('Browser session closed during annotation capture.');
    const projectedTab = snapshot.tabs.find((candidate) => candidate.id === tabId);
    if (projectedTab == null) throw new Error('Browser tab closed during annotation capture.');
    return Object.freeze({
      protocolVersion: 1,
      source: presentation.source,
      snapshot,
      tabId,
      url: projectedTab.url,
      viewportRevision: projectedTab.viewportRevision,
      presentationBounds: Object.freeze({ ...frame.bounds }),
      cssViewport: Object.freeze({ width: frame.page.width, height: frame.page.height }),
      physicalPixels: Object.freeze(physicalPixels),
      scroll: Object.freeze({ x: frame.page.scrollX, y: frame.page.scrollY }),
      deviceScaleFactor: frame.deviceScaleFactor,
      zoomFactor: frame.zoomFactor,
      pngBase64: frame.png.toString('base64'),
    });
  }

  park(rendererId: number, leaseId: string): boolean {
    if (this.active == null || this.active.leaseId !== leaseId) return false;
    if (this.active.rendererId !== rendererId) return false;
    this.revokeActive();
    return true;
  }

  observeProjection(event: BrowserStateProjectionEvent): void {
    if (event.snapshot != null || this.active == null) return;
    if (browserStateSourceKey(event.source) === this.active.sourceKey) this.revokeActive();
  }

  reset(): void {
    this.revokeActive();
  }

  private requireRendererWindow(rendererId: number): BrowserWindow {
    const window = this.getWindow();
    if (
      window == null || window.isDestroyed() || window.webContents.isDestroyed() ||
      window.webContents.id !== rendererId
    ) {
      throw new Error('Browser presentation is only available in the active Agent Deck window.');
    }
    return window;
  }

  private requireActive(rendererId: number, leaseId: string): ActivePresentation {
    const window = this.requireRendererWindow(rendererId);
    const active = this.active;
    if (
      active == null || active.leaseId !== leaseId || active.rendererId !== rendererId ||
      active.window !== window
    ) {
      throw new Error('Browser presentation lease is stale.');
    }
    return active;
  }

  private requireOwner(presentation: ActivePresentation): BrowserOwnerHandle {
    if (this.projection.owner(presentation.source) !== presentation.ownerId) {
      throw new Error('Browser presentation source changed.');
    }
    const handle = this.getOwner(presentation.ownerId);
    if (handle == null) throw new Error('Browser session is no longer available.');
    return handle;
  }

  private revokeActive(): void {
    this.getHost().parkAll();
    this.active = null;
  }
}
