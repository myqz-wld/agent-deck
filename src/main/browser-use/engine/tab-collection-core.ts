import type { TabInfo } from './types';

export interface BrowserTabResource {
  readonly id: number;
  close(): void;
  destroy(): void;
  info(active: boolean): TabInfo;
  isDestroyed(): boolean;
}

/** Per-owner tab identity, active selection, observation, and disposal state. */
export class BrowserTabCollectionCore<Tab extends BrowserTabResource> {
  private readonly tabs = new Map<number, Tab>();
  private readonly tabClosedListeners = new Set<(tabId: number) => void>();
  private nextId = 1;
  private activeId: number | null = null;
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  assertOpen(): void {
    if (this.disposed) throw new Error('This browser session is closed.');
  }

  allocateTabId(): number {
    this.assertOpen();
    return this.nextId++;
  }

  register(tab: Tab): void {
    this.assertOpen();
    this.tabs.set(tab.id, tab);
    this.activeId = tab.id;
  }

  listTabs(): Tab[] {
    this.prune();
    return [...this.tabs.values()];
  }

  listTabInfos(): TabInfo[] {
    const tabs = this.listTabs();
    if (this.activeId == null || !this.tabs.has(this.activeId)) {
      this.activeId = tabs[0]?.id ?? null;
    }
    return tabs.map((tab) => tab.info(tab.id === this.activeId));
  }

  getTab(tabId: number): Tab | null {
    this.prune();
    return this.tabs.get(tabId) ?? null;
  }

  requireTab(tabId: number): Tab {
    const tab = this.getTab(tabId);
    if (tab == null) throw new Error(`Unknown tab: ${tabId}`);
    return tab;
  }

  activeTab(): Tab | null {
    this.prune();
    if (this.activeId == null) return null;
    return this.tabs.get(this.activeId) ?? null;
  }

  isActive(tabId: number): boolean {
    return this.activeId === tabId;
  }

  markActive(tabId: number): void {
    if (this.tabs.has(tabId)) this.activeId = tabId;
  }

  tabCount(): number {
    this.prune();
    return this.tabs.size;
  }

  closeTab(tabId: number): void {
    this.getTab(tabId)?.close();
  }

  onTabClosed(listener: (tabId: number) => void): () => void {
    if (this.disposed) return () => {};
    this.tabClosedListeners.add(listener);
    return () => this.tabClosedListeners.delete(listener);
  }

  keepOnly(tabIds: readonly number[]): void {
    const keep = new Set(tabIds);
    for (const tab of this.listTabs()) {
      if (!keep.has(tab.id)) tab.close();
    }
  }

  forget(tabId: number): void {
    if (!this.tabs.delete(tabId)) return;
    if (this.activeId === tabId) this.activeId = null;
    for (const listener of [...this.tabClosedListeners]) listener(tabId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tab of [...this.tabs.values()]) {
      tab.destroy();
      this.forget(tab.id);
    }
    this.activeId = null;
    this.tabClosedListeners.clear();
  }

  private prune(): void {
    for (const [tabId, tab] of this.tabs) {
      if (tab.isDestroyed()) this.forget(tabId);
    }
  }
}
