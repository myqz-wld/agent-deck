import { describe, expect, it, vi } from 'vitest';
import {
  BrowserOwnershipRegistryCore,
  type BrowserOwnerResource,
} from './registry-core';

function resource(): BrowserOwnerResource & { tabs: number } {
  return {
    isDisposed: false,
    tabs: 0,
    dispose: vi.fn(async function (this: { isDisposed: boolean }) {
      this.isDisposed = true;
    }),
    tabCount() {
      return this.tabs;
    },
  };
}

describe('browser ownership registry Core', () => {
  it('reuses one live owner and keeps separate ownership handles per session', () => {
    const createHandle = vi.fn(() => resource());
    const registry = new BrowserOwnershipRegistryCore({ createHandle });
    const owner = { kind: 'session', id: 'same' } as const;

    const first = registry.acquire(owner);
    expect(registry.acquire(owner)).toBe(first);
    expect(createHandle).toHaveBeenCalledOnce();
    expect(registry.acquire({ kind: 'session', id: 'other' })).not.toBe(first);
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it('enforces per-owner and total caps without creating extra owners', () => {
    const registry = new BrowserOwnershipRegistryCore({
      createHandle: () => resource(),
      maxTabsPerOwner: 1,
      maxTotalTabs: 1,
    });
    const first = registry.acquire({ kind: 'session', id: 'first' });
    first.tabs = 1;

    expect(() => registry.assertCapacity(first)).toThrow(/already has 1/);
    const second = registry.acquire({ kind: 'session', id: 'second' });
    expect(() => registry.assertCapacity(second)).toThrow(/global limit of 1/);
  });
});
