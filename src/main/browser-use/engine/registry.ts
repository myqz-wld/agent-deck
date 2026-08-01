/**
 * Ownership registry for the browser engine.
 *
 * Tabs belong to an owner key, never to a transport connection. That is the whole reason this file
 * exists: the Agent Deck MCP server uses a stateless HTTP transport with a fresh transport instance
 * per request, so any browser state parked on a connection would evaporate between two tool calls.
 *
 * Caps are enforced here because both fronts share one Electron process.
 */

import { createHash } from 'node:crypto';

import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import { EngineTab, buildTabWindowOptions } from './tab';
import {
  BrowserTabLimitError,
  DEFAULT_MAX_TABS_PER_OWNER,
  DEFAULT_MAX_TOTAL_TABS,
  DEFAULT_WINDOW_TITLE,
  INITIAL_URL,
  type BrowserEngineOptions,
  type BrowserOwnerKey,
  type CreateTabOptions,
  type TabInfo,
} from './types';

export function ownerCacheKey(owner: BrowserOwnerKey): string {
  return `${owner.kind}:${owner.id}`;
}

export function ownerPartition(owner: BrowserOwnerKey): string {
  const digest = createHash('sha256').update(ownerCacheKey(owner)).digest('hex').slice(0, 20);
  return `agent-deck-browser-${digest}`;
}

export class BrowserOwnerHandle {
  readonly partition: string;
  private readonly tabs = new Map<number, EngineTab>();
  private readonly tabClosedListeners = new Set<(tabId: number) => void>();
  private nextTabId = 1;
  private activeTabId: number | null = null;
  private disposed = false;

  constructor(
    readonly key: BrowserOwnerKey,
    private readonly engine: BrowserEngine,
  ) {
    this.partition = ownerPartition(key);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async openTab(options: CreateTabOptions = {}): Promise<EngineTab> {
    if (this.disposed) throw new Error('This browser session is closed.');
    this.prune();
    this.engine.assertCapacity(this);

    const tabId = this.nextTabId++;
    const window = this.engine.createWindow(
      buildTabWindowOptions(this.partition, this.engine.windowTitle),
    );
    const tab = new EngineTab({
      id: tabId,
      window,
      onActivated: (id) => {
        if (this.tabs.has(id)) this.activeTabId = id;
      },
      onClosed: (id) => this.forgetTab(id),
    });
    this.tabs.set(tabId, tab);
    this.activeTabId = tabId;

    await tab.loadUrl(INITIAL_URL);
    if (options.show ?? this.engine.showWindows) tab.show();
    return tab;
  }

  /** Reuse the current tab when one exists, otherwise open one. */
  async ensureTab(options: CreateTabOptions = {}): Promise<EngineTab> {
    const existing = this.activeTab() ?? this.listTabs()[0] ?? null;
    return existing ?? this.openTab(options);
  }

  listTabs(): EngineTab[] {
    this.prune();
    return [...this.tabs.values()];
  }

  listTabInfos(): TabInfo[] {
    const tabs = this.listTabs();
    if (this.activeTabId == null || !this.tabs.has(this.activeTabId)) {
      this.activeTabId = tabs[0]?.id ?? null;
    }
    return tabs.map((tab) => tab.info(tab.id === this.activeTabId));
  }

  getTab(tabId: number): EngineTab | null {
    this.prune();
    return this.tabs.get(tabId) ?? null;
  }

  requireTab(tabId: number): EngineTab {
    const tab = this.getTab(tabId);
    if (tab == null) throw new Error(`Unknown tab: ${tabId}`);
    return tab;
  }

  activeTab(): EngineTab | null {
    this.prune();
    if (this.activeTabId == null) return null;
    return this.tabs.get(this.activeTabId) ?? null;
  }

  isActive(tabId: number): boolean {
    return this.activeTabId === tabId;
  }

  markActive(tabId: number): void {
    if (this.tabs.has(tabId)) this.activeTabId = tabId;
  }

  tabCount(): number {
    this.prune();
    return this.tabs.size;
  }

  closeTab(tabId: number): void {
    this.getTab(tabId)?.close();
  }

  /** Observe EngineTab removal without retaining its BrowserWindow or webContents. */
  onTabClosed(listener: (tabId: number) => void): () => void {
    if (this.disposed) return () => {};
    this.tabClosedListeners.add(listener);
    return () => {
      this.tabClosedListeners.delete(listener);
    };
  }

  /** Close every tab except the given ids. Used by the Codex `finalizeTabs` request. */
  keepOnly(tabIds: readonly number[]): void {
    const keep = new Set(tabIds);
    for (const tab of this.listTabs()) {
      if (!keep.has(tab.id)) tab.close();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const tabs = [...this.tabs.values()];
    for (const tab of tabs) {
      tab.destroy();
      // A destroyed test double or already-closed native window may not emit `closed` again.
      this.forgetTab(tab.id);
    }
    this.activeTabId = null;
    this.tabClosedListeners.clear();
  }

  private prune(): void {
    for (const [tabId, tab] of this.tabs) {
      if (tab.isDestroyed()) this.forgetTab(tabId);
    }
  }

  private forgetTab(tabId: number): void {
    if (!this.tabs.delete(tabId)) return;
    if (this.activeTabId === tabId) this.activeTabId = null;
    for (const listener of [...this.tabClosedListeners]) listener(tabId);
  }
}

interface BrowserOwnerRecord {
  readonly handle: BrowserOwnerHandle;
  leases: number;
}

export class BrowserOwnerLease {
  private released = false;

  constructor(
    readonly handle: BrowserOwnerHandle,
    private readonly releaseRecord: () => Promise<void>,
  ) {}

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.releaseRecord();
  }
}

export class BrowserEngine {
  readonly showWindows: boolean;
  readonly windowTitle: string;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  private readonly owners = new Map<string, BrowserOwnerRecord>();
  private readonly maxTabsPerOwner: number;
  private readonly maxTotalTabs: number;

  constructor(options: BrowserEngineOptions = {}) {
    this.createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
    this.showWindows = options.showWindows ?? false;
    this.windowTitle = options.windowTitle ?? DEFAULT_WINDOW_TITLE;
    this.maxTabsPerOwner = options.maxTabsPerOwner ?? DEFAULT_MAX_TABS_PER_OWNER;
    this.maxTotalTabs = options.maxTotalTabs ?? DEFAULT_MAX_TOTAL_TABS;
  }

  acquire(owner: BrowserOwnerKey): BrowserOwnerHandle {
    return this.ensureOwner(owner).handle;
  }

  acquireLease(owner: BrowserOwnerKey & { kind: 'codex-pipe' }): BrowserOwnerLease {
    const cacheKey = ownerCacheKey(owner);
    const record = this.ensureOwner(owner);
    record.leases += 1;
    return new BrowserOwnerLease(
      record.handle,
      () => this.releaseLease(cacheKey, record),
    );
  }

  peek(owner: BrowserOwnerKey): BrowserOwnerHandle | null {
    const record = this.owners.get(ownerCacheKey(owner));
    return record == null || record.handle.isDisposed ? null : record.handle;
  }

  async disposeOwner(owner: BrowserOwnerKey): Promise<void> {
    const cacheKey = ownerCacheKey(owner);
    const record = this.owners.get(cacheKey);
    this.owners.delete(cacheKey);
    await record?.handle.dispose();
  }

  async disposeAll(): Promise<void> {
    const records = [...this.owners.values()];
    this.owners.clear();
    await Promise.all(records.map((record) => record.handle.dispose()));
  }

  totalTabs(): number {
    let total = 0;
    for (const record of this.owners.values()) total += record.handle.tabCount();
    return total;
  }

  /** Throws `BrowserTabLimitError` when opening one more tab would break a cap. */
  assertCapacity(handle: BrowserOwnerHandle): void {
    if (handle.tabCount() >= this.maxTabsPerOwner) {
      throw new BrowserTabLimitError(
        `This session already has ${this.maxTabsPerOwner} browser tabs. Close one before opening another.`,
      );
    }
    if (this.totalTabs() >= this.maxTotalTabs) {
      throw new BrowserTabLimitError(
        `Agent Deck reached its global limit of ${this.maxTotalTabs} browser tabs. Close tabs in other sessions first.`,
      );
    }
  }

  private ensureOwner(owner: BrowserOwnerKey): BrowserOwnerRecord {
    const cacheKey = ownerCacheKey(owner);
    const existing = this.owners.get(cacheKey);
    if (existing != null && !existing.handle.isDisposed) return existing;
    const record = {
      handle: new BrowserOwnerHandle(owner, this),
      leases: 0,
    };
    this.owners.set(cacheKey, record);
    return record;
  }

  private async releaseLease(
    cacheKey: string,
    record: BrowserOwnerRecord,
  ): Promise<void> {
    record.leases = Math.max(0, record.leases - 1);
    if (record.leases !== 0 || this.owners.get(cacheKey) !== record) return;
    this.owners.delete(cacheKey);
    await record.handle.dispose();
  }
}

let sharedEngine: BrowserEngine | null = null;

/** Shared production engine. Follows the repository `setX`/`getX` singleton convention. */
export function getBrowserEngine(): BrowserEngine {
  sharedEngine ??= new BrowserEngine();
  return sharedEngine;
}

export function setBrowserEngine(engine: BrowserEngine | null): void {
  sharedEngine = engine;
}
