import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { BrowserShowRequest, BrowserStateSource } from '@shared/browser-view';
import type { BrowserOwnerHandle } from './engine/registry';
import type { BrowserTabShowTarget, EngineTabSurface } from './engine/surface';
import type { BrowserStateProjectionRegistry } from './browser-state-projection';

interface PendingShow {
  request: BrowserShowRequest;
  surface: EngineTabSurface;
  window: BrowserWindow;
  presented: boolean;
  promise: Promise<boolean>;
  finish(visible: boolean): void;
}

export interface BrowserShowControllerOptions {
  projection: BrowserStateProjectionRegistry;
  getOwner(ownerId: string): BrowserOwnerHandle | null;
  getWindow(): BrowserWindow | null;
  ensureWindow(): BrowserWindow | null;
  notify(request: BrowserShowRequest | null): void;
  timeoutMs?: number;
}

/** One explicit foreground intent, completed only by an owner-qualified IAB placement. */
export class BrowserShowController {
  private pending: PendingShow | null = null;
  constructor(private readonly options: BrowserShowControllerOptions) {}

  request(surface: EngineTabSurface, target?: BrowserTabShowTarget): Promise<boolean> {
    if (!target || !this.validOwner(surface, target)) return Promise.resolve(false);
    if (this.pending?.surface === surface) return this.pending.promise;
    this.reset();
    const window = this.options.ensureWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.resolve(false);
    }
    const request: BrowserShowRequest = {
      requestId: randomUUID(),
      source: { kind: 'local', sessionId: target.ownerId },
      tabId: target.tabId,
    };
    let resolve!: (visible: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    const closed = () => pending.finish(false);
    const focused = () => this.completeIfVisible();
    const offSurface = surface.onClosed(closed);
    const timer = setTimeout(closed, this.options.timeoutMs ?? 5_000);
    const pending: PendingShow = {
      request, surface, window, promise, presented: false,
      finish: (visible) => {
        if (this.pending !== pending) return;
        this.pending = null;
        clearTimeout(timer);
        offSurface();
        window.removeListener('closed', closed);
        window.removeListener('focus', focused);
        window.webContents.removeListener('destroyed', closed);
        resolve(visible);
        this.notify(null);
      },
    };
    this.pending = pending;
    window.once('closed', closed);
    window.on('focus', focused);
    window.webContents.once('destroyed', closed);
    try {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      this.notify(request);
    } catch {
      pending.finish(false);
    }
    return promise;
  }

  getPending(rendererId: number): BrowserShowRequest | null {
    const pending = this.pending;
    if (!pending) return null;
    if (!this.validPending(pending)) {
      pending.finish(false);
      return null;
    }
    return pending.window.webContents.id === rendererId ? pending.request : null;
  }

  observePresentation(rendererId: number, source: BrowserStateSource, tabId: number): void {
    const pending = this.pending;
    if (!pending || source.kind !== 'local' ||
      source.sessionId !== pending.request.source.sessionId ||
      tabId !== pending.request.tabId || rendererId !== pending.window.webContents.id) return;
    pending.presented = true;
    this.completeIfVisible();
  }

  reset(): void { this.pending?.finish(false); }

  private notify(request: BrowserShowRequest | null): void {
    // Delivery may race renderer teardown. The bounded waiter and pending-state read remain valid.
    try { this.options.notify(request); } catch {}
  }

  private validOwner(surface: EngineTabSurface, target: BrowserTabShowTarget): boolean {
    return !surface.isDestroyed() &&
      this.options.getOwner(target.ownerId)?.getTab(target.tabId)?.hasSurface(surface) === true &&
      this.options.projection.owner({ kind: 'local', sessionId: target.ownerId }) === target.ownerId;
  }

  private validPending(pending: PendingShow): boolean {
    return this.options.getWindow() === pending.window && !pending.window.isDestroyed() &&
      !pending.window.webContents.isDestroyed() && this.validOwner(pending.surface, {
        ownerId: pending.request.source.sessionId, tabId: pending.request.tabId,
      });
  }

  private completeIfVisible(): void {
    const pending = this.pending;
    if (!pending) return;
    if (!this.validPending(pending)) pending.finish(false);
    else if (pending.presented && pending.surface.canSendInputEvents()) pending.finish(true);
  }
}
