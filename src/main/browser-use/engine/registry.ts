/**
 * Ownership registry for the browser engine.
 *
 * Tabs belong to an Agent Deck session, never to a transport connection. The CLI and Remote broker
 * can therefore reconnect without losing browser state. Caps are enforced here because all
 * sessions share one Electron process.
 */

import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import { EngineTab, buildTabWindowOptions } from './tab';
import { BrowserWindowTabSurface, type EngineTabSurface } from './surface';
import { getBrowserViewHost } from '../view-host';
import {
  DEFAULT_WINDOW_TITLE,
  INITIAL_URL,
  type BrowserEngineOptions,
  type BrowserOwnerKey,
  type CreateTabOptions,
  type TabInfo,
} from './types';
import {
  BrowserOwnershipRegistryCore,
  ownerPartition,
} from './registry-core';
import { BrowserTabCollectionCore } from './tab-collection-core';

const defaultWindowFactory = (
  windowOptions: BrowserWindowConstructorOptions,
): BrowserWindow => new BrowserWindow(windowOptions);

export {
  ownerCacheKey,
  ownerPartition,
} from './registry-core';

export class BrowserOwnerHandle {
  readonly partition: string;
  private readonly tabs = new BrowserTabCollectionCore<EngineTab>();

  constructor(
    readonly key: BrowserOwnerKey,
    private readonly engine: BrowserEngine,
  ) {
    this.partition = ownerPartition(key);
  }

  get isDisposed(): boolean {
    return this.tabs.isDisposed;
  }

  async openTab(options: CreateTabOptions = {}): Promise<EngineTab> {
    this.tabs.assertOpen();
    this.tabs.listTabs();
    this.engine.assertCapacity(this);

    const tabId = this.tabs.allocateTabId();
    const surface = this.engine.createTabSurface(this.partition);
    const tab = new EngineTab({
      id: tabId,
      surface,
      onActivated: (id) => this.tabs.markActive(id),
      onClosed: (id) => this.tabs.forget(id),
    });
    this.tabs.register(tab);

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
    return this.tabs.listTabs();
  }

  listTabInfos(): TabInfo[] {
    return this.tabs.listTabInfos();
  }

  getTab(tabId: number): EngineTab | null {
    return this.tabs.getTab(tabId);
  }

  requireTab(tabId: number): EngineTab {
    return this.tabs.requireTab(tabId);
  }

  activeTab(): EngineTab | null {
    return this.tabs.activeTab();
  }

  isActive(tabId: number): boolean {
    return this.tabs.isActive(tabId);
  }

  markActive(tabId: number): void {
    this.tabs.markActive(tabId);
  }

  tabCount(): number {
    return this.tabs.tabCount();
  }

  closeTab(tabId: number): void {
    this.tabs.closeTab(tabId);
  }

  /** Close every tab except the given ids. */
  keepOnly(tabIds: readonly number[]): void {
    this.tabs.keepOnly(tabIds);
  }

  async dispose(): Promise<void> {
    this.tabs.dispose();
  }
}

export class BrowserEngine {
  readonly showWindows: boolean;
  readonly windowTitle: string;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  private readonly configuredCreateSurface: BrowserEngineOptions['createSurface'];
  private readonly ownership: BrowserOwnershipRegistryCore<BrowserOwnerHandle>;

  constructor(options: BrowserEngineOptions = {}) {
    this.createWindow = options.createWindow ?? defaultWindowFactory;
    this.configuredCreateSurface = options.createSurface;
    this.showWindows = options.showWindows ?? false;
    this.windowTitle = options.windowTitle ?? DEFAULT_WINDOW_TITLE;
    this.ownership = new BrowserOwnershipRegistryCore({
      createHandle: (owner) => new BrowserOwnerHandle(owner, this),
      maxTabsPerOwner: options.maxTabsPerOwner,
      maxTotalTabs: options.maxTotalTabs,
    });
  }

  createTabSurface(partition: string): EngineTabSurface {
    if (this.configuredCreateSurface) {
      return this.configuredCreateSurface({ partition, title: this.windowTitle });
    }
    if (this.createWindow !== defaultWindowFactory) {
      return new BrowserWindowTabSurface(
        this.createWindow(buildTabWindowOptions(partition, this.windowTitle)),
      );
    }
    return getBrowserViewHost().createSurface({ partition, title: this.windowTitle });
  }

  acquire(owner: BrowserOwnerKey): BrowserOwnerHandle {
    return this.ownership.acquire(owner);
  }

  peek(owner: BrowserOwnerKey): BrowserOwnerHandle | null {
    return this.ownership.peek(owner);
  }

  async disposeOwner(owner: BrowserOwnerKey): Promise<void> {
    await this.ownership.disposeOwner(owner);
  }

  async disposeAll(): Promise<void> {
    await this.ownership.disposeAll();
  }

  totalTabs(): number {
    return this.ownership.totalTabs();
  }

  /** Throws `BrowserTabLimitError` when opening one more tab would break a cap. */
  assertCapacity(handle: BrowserOwnerHandle): void {
    this.ownership.assertCapacity(handle);
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
