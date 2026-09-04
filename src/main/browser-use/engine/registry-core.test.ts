import { describe, expect, it, vi } from 'vitest';
import {
  BrowserOwnershipRegistryCore,
  ownerPartition,
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
  it('isolates session partitions and reuses one live owner', () => {
    const createHandle = vi.fn(() => resource());
    const registry = new BrowserOwnershipRegistryCore({ createHandle });
    const owner = { kind: 'session', id: 'same' } as const;

    expect(registry.acquire(owner)).toBe(registry.acquire(owner));
    expect(createHandle).toHaveBeenCalledOnce();
    expect(ownerPartition(owner)).not.toBe(
      ownerPartition({ kind: 'session', id: 'other' }),
    );
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
