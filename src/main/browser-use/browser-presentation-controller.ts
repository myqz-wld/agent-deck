import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

import type {
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

interface BrowserPresentationHost {
  parkAll(): void;
  updateParkingViewport(size: { width: number; height: number }): void;
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
