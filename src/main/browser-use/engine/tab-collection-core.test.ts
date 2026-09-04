import { describe, expect, it, vi } from 'vitest';
import {
  BrowserTabCollectionCore,
  type BrowserTabResource,
} from './tab-collection-core';

function tab(id: number): BrowserTabResource & { destroyed: boolean } {
  return {
    id,
    destroyed: false,
    close: vi.fn(function (this: { destroyed: boolean }) {
      this.destroyed = true;
    }),
    destroy: vi.fn(function (this: { destroyed: boolean }) {
      this.destroyed = true;
    }),
    info(active) {
      return { id, active, title: `tab-${id}`, url: `https://${id}.test` };
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
}

describe('browser tab collection Core', () => {
  it('allocates per-owner ids, tracks activation, and prunes destroyed tabs', () => {
    const collection = new BrowserTabCollectionCore<ReturnType<typeof tab>>();
    const first = tab(collection.allocateTabId());
    const second = tab(collection.allocateTabId());
    collection.register(first);
    collection.register(second);

    expect(collection.listTabInfos().map(({ id, active }) => [id, active])).toEqual([
      [1, false],
      [2, true],
    ]);
    collection.markActive(1);
    second.destroyed = true;
    expect(collection.listTabs()).toEqual([first]);
    expect(collection.activeTab()).toBe(first);
  });

  it('keeps selected tabs and makes disposal idempotent', () => {
    const collection = new BrowserTabCollectionCore<ReturnType<typeof tab>>();
    const keep = tab(collection.allocateTabId());
    const close = tab(collection.allocateTabId());
    collection.register(keep);
    collection.register(close);
    collection.keepOnly([keep.id]);
    expect(close.close).toHaveBeenCalledOnce();
    collection.listTabs();
    collection.dispose();
    collection.dispose();
    expect(keep.destroy).toHaveBeenCalledOnce();
    expect(collection.listTabs()).toEqual([]);
    expect(() => collection.allocateTabId()).toThrow('browser session is closed');
  });
});
