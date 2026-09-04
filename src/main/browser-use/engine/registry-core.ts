import { createHash } from 'node:crypto';

import {
  BrowserTabLimitError,
  DEFAULT_MAX_TABS_PER_OWNER,
  DEFAULT_MAX_TOTAL_TABS,
  type BrowserOwnerKey,
} from './types';

export interface BrowserOwnerResource {
  readonly isDisposed: boolean;
  dispose(): Promise<void>;
  tabCount(): number;
}

interface BrowserOwnerRecord<Handle extends BrowserOwnerResource> {
  readonly handle: Handle;
}

export interface BrowserOwnershipRegistryOptions<Handle extends BrowserOwnerResource> {
  createHandle(owner: BrowserOwnerKey): Handle;
  maxTabsPerOwner?: number;
  maxTotalTabs?: number;
}

export function ownerCacheKey(owner: BrowserOwnerKey): string {
  return `${owner.kind}:${owner.id}`;
}

export function ownerPartition(owner: BrowserOwnerKey): string {
  const digest = createHash('sha256')
    .update(ownerCacheKey(owner))
    .digest('hex')
    .slice(0, 20);
  return `agent-deck-browser-${digest}`;
}

/** Provider-neutral ownership, lease, disposal, and capacity state machine. */
export class BrowserOwnershipRegistryCore<Handle extends BrowserOwnerResource> {
  private readonly owners = new Map<string, BrowserOwnerRecord<Handle>>();
  private readonly maxTabsPerOwner: number;
  private readonly maxTotalTabs: number;

  constructor(private readonly options: BrowserOwnershipRegistryOptions<Handle>) {
    this.maxTabsPerOwner =
      options.maxTabsPerOwner ?? DEFAULT_MAX_TABS_PER_OWNER;
    this.maxTotalTabs = options.maxTotalTabs ?? DEFAULT_MAX_TOTAL_TABS;
  }

  acquire(owner: BrowserOwnerKey): Handle {
    return this.ensureOwner(owner).handle;
  }

  peek(owner: BrowserOwnerKey): Handle | null {
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
    for (const record of this.owners.values()) {
      total += record.handle.tabCount();
    }
    return total;
  }

  assertCapacity(handle: Handle): void {
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

  private ensureOwner(owner: BrowserOwnerKey): BrowserOwnerRecord<Handle> {
    const cacheKey = ownerCacheKey(owner);
    const existing = this.owners.get(cacheKey);
    if (existing != null && !existing.handle.isDisposed) return existing;
    const record = { handle: this.options.createHandle(owner) };
    this.owners.set(cacheKey, record);
    return record;
  }
}
