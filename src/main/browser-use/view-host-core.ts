export interface BrowserViewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserViewSize {
  readonly width: number;
  readonly height: number;
}

export interface BrowserViewLike {
  setBounds(bounds: BrowserViewBounds): void;
  setVisible(visible: boolean): void;
}

export interface BrowserViewContentLike {
  addChildView(view: BrowserViewLike): void;
  removeChildView(view: BrowserViewLike): void;
}

export interface BrowserViewWindowLike {
  readonly contentView: BrowserViewContentLike;
  getContentBounds(): BrowserViewBounds;
  getBounds(): BrowserViewBounds;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
}

export interface BrowserVisualMetrics {
  readonly deviceScaleFactor: number;
  readonly zoomFactor: number;
}

export interface BrowserViewHostCoreOptions {
  readonly parkingWindow: BrowserViewWindowLike;
  readonly initialViewport?: BrowserViewSize;
}

interface BrowserViewRecord {
  readonly view: BrowserViewLike;
  readonly handle: BrowserViewPlacementHandle;
  host: BrowserViewWindowLike;
  bounds: BrowserViewBounds;
  viewportRevision: number;
  metrics: BrowserVisualMetrics;
  disposed: boolean;
}

function integer(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function boundedSize(size: BrowserViewSize): BrowserViewSize {
  return {
    width: Math.max(1, integer(size.width)),
    height: Math.max(1, integer(size.height)),
  };
}

function sameViewport(left: BrowserViewBounds, right: BrowserViewBounds): boolean {
  return left.width === right.width && left.height === right.height;
}

export class BrowserViewPlacementHandle {
  constructor(
    private readonly owner: BrowserViewHostCore,
    private readonly record: BrowserViewRecord,
  ) {}

  get viewportRevision(): number {
    return this.record.viewportRevision;
  }

  get bounds(): BrowserViewBounds {
    return { ...this.record.bounds };
  }

  get isDisposed(): boolean {
    return this.record.disposed;
  }

  canSendInputEvents(): boolean {
    return this.owner.canSendInputEvents(this.record);
  }

  updateVisualMetrics(metrics: BrowserVisualMetrics): void {
    this.owner.updateVisualMetrics(this.record, metrics);
  }

  park(): boolean {
    return this.owner.park(this.record);
  }

  dispose(): boolean {
    return this.owner.dispose(this.record);
  }
}

/** Pure placement state machine for attached, always-visible Browser WebContentsViews. */
export class BrowserViewHostCore {
  private readonly parkingWindow: BrowserViewWindowLike;
  private readonly records = new Set<BrowserViewRecord>();
  private parkingViewport: BrowserViewSize;
  private presented: BrowserViewRecord | null = null;

  constructor(options: BrowserViewHostCoreOptions) {
    this.parkingWindow = options.parkingWindow;
    this.parkingViewport = boundedSize(options.initialViewport ?? { width: 420, height: 480 });
  }

  register(view: BrowserViewLike): BrowserViewPlacementHandle {
    const bounds = this.parkingBounds();
    const record = {} as BrowserViewRecord;
    const handle = new BrowserViewPlacementHandle(this, record);
    Object.assign(record, {
      view,
      handle,
      host: this.parkingWindow,
      bounds,
      viewportRevision: 1,
      metrics: { deviceScaleFactor: 1, zoomFactor: 1 },
      disposed: false,
    });
    this.records.add(record);
    this.parkingWindow.contentView.addChildView(view);
    view.setBounds(bounds);
    view.setVisible(true);
    return handle;
  }

  present(
    handle: BrowserViewPlacementHandle,
    target: BrowserViewWindowLike,
    requestedBounds: BrowserViewBounds,
  ): BrowserViewBounds | null {
    const record = this.recordFor(handle);
    if (record == null) return null;
    if (target.isDestroyed()) {
      this.parkAll();
      return null;
    }
    const bounds = this.clipBounds(target, requestedBounds);
    if (bounds == null) {
      this.park(record);
      return null;
    }
    if (this.presented != null && this.presented !== record) this.park(this.presented);
    if (record.host !== target) this.reparent(record, target);
    this.applyBounds(record, bounds);
    record.view.setVisible(true);
    this.presented = record;
    return { ...bounds };
  }

  parkAll(): void {
    for (const record of this.records) this.park(record);
  }

  updateParkingViewport(size: BrowserViewSize): void {
    this.parkingViewport = boundedSize(size);
    for (const record of this.records) {
      if (record.host !== this.parkingWindow) continue;
      this.applyBounds(record, this.parkingBounds());
      record.view.setVisible(true);
    }
  }

  windowFor(handle: BrowserViewPlacementHandle): BrowserViewWindowLike | null {
    return this.recordFor(handle)?.host ?? null;
  }

  isPresented(handle: BrowserViewPlacementHandle): boolean {
    const record = this.recordFor(handle);
    return record != null && this.presented === record;
  }

  canSendInputEvents(record: BrowserViewRecord): boolean {
    return !record.disposed && this.presented === record &&
      !record.host.isDestroyed() && record.host.isVisible() && record.host.isFocused();
  }

  updateVisualMetrics(record: BrowserViewRecord, metrics: BrowserVisualMetrics): void {
    if (record.disposed) return;
    const next = {
      deviceScaleFactor: Number.isFinite(metrics.deviceScaleFactor) && metrics.deviceScaleFactor > 0
        ? metrics.deviceScaleFactor
        : 1,
      zoomFactor: Number.isFinite(metrics.zoomFactor) && metrics.zoomFactor > 0
        ? metrics.zoomFactor
        : 1,
    };
    if (
      next.deviceScaleFactor === record.metrics.deviceScaleFactor &&
      next.zoomFactor === record.metrics.zoomFactor
    ) return;
    record.metrics = next;
    record.viewportRevision += 1;
  }

  park(record: BrowserViewRecord): boolean {
    if (record.disposed) return false;
    if (record.host !== this.parkingWindow) this.reparent(record, this.parkingWindow);
    this.applyBounds(record, this.parkingBounds());
    record.view.setVisible(true);
    if (this.presented === record) this.presented = null;
    return true;
  }

  dispose(record: BrowserViewRecord): boolean {
    if (record.disposed || !this.records.has(record)) return false;
    record.disposed = true;
    this.records.delete(record);
    if (this.presented === record) this.presented = null;
    try {
      record.host.contentView.removeChildView(record.view);
    } catch {
      // A host can be destroyed concurrently; the view owner still retires exactly once.
    }
    return true;
  }

  private recordFor(handle: BrowserViewPlacementHandle): BrowserViewRecord | null {
    for (const record of this.records) {
      if (record.handle === handle && !record.disposed) return record;
    }
    return null;
  }

  private reparent(record: BrowserViewRecord, target: BrowserViewWindowLike): void {
    try {
      record.host.contentView.removeChildView(record.view);
    } catch {
      // Destroyed old hosts are already detached from Chromium's view tree.
    }
    target.contentView.addChildView(record.view);
    record.host = target;
  }

  private applyBounds(record: BrowserViewRecord, bounds: BrowserViewBounds): void {
    if (!sameViewport(record.bounds, bounds)) record.viewportRevision += 1;
    record.bounds = bounds;
    record.view.setBounds(bounds);
  }

  private parkingBounds(): BrowserViewBounds {
    return { x: 0, y: 0, ...this.parkingViewport };
  }

  private clipBounds(
    target: BrowserViewWindowLike,
    requested: BrowserViewBounds,
  ): BrowserViewBounds | null {
    const content = target.getContentBounds();
    const contentWidth = Math.max(0, integer(content.width));
    const contentHeight = Math.max(0, integer(content.height));
    const x = Math.max(0, Math.min(contentWidth, integer(requested.x)));
    const y = Math.max(0, Math.min(contentHeight, integer(requested.y)));
    const width = Math.max(0, Math.min(integer(requested.width), contentWidth - x));
    const height = Math.max(0, Math.min(integer(requested.height), contentHeight - y));
    return width < 1 || height < 1 ? null : { x, y, width, height };
  }
}
