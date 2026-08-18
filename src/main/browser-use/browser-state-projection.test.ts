import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserEngine, setBrowserEngine } from './engine/registry';
import { fakeWindowFactory } from './engine/__tests__/_fakes';
import {
  BrowserStateProjectionRegistry,
  browserStateSourceKey,
  type RemoteBrowserStateSource,
} from './browser-state-projection';
import { acquireSessionBrowser } from './session-browser';

const source: RemoteBrowserStateSource = {
  kind: 'remote',
  profileId: 'profile-a',
  coreId: 'core-a',
  generation: 2,
  sessionId: 'session-a',
};

beforeEach(() => setBrowserEngine(new BrowserEngine(fakeWindowFactory())));

describe('Browser state projection registry', () => {
  it('publishes only source-qualified tab metadata with monotonic revisions', async () => {
    const registry = new BrowserStateProjectionRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const owner = acquireSessionBrowser('opaque-desktop-owner');
    await owner.openTab();

    const opened = registry.publish(source, 'opaque-desktop-owner');
    await owner.openTab();
    const updated = registry.publish(source, 'opaque-desktop-owner');

    expect(opened.snapshot).toMatchObject({
      protocolVersion: 1,
      revision: 1,
      source,
      tabs: [{ id: 1, active: true, viewportRevision: 1 }],
    });
    expect(updated).toMatchObject({ revision: 2, snapshot: { tabs: [{ id: 1 }, { id: 2 }] } });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updated)).not.toContain('opaque-desktop-owner');
  });

  it('does not increment or emit when projected state is unchanged', async () => {
    const registry = new BrowserStateProjectionRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    await acquireSessionBrowser('owner-stable').openTab();

    const first = registry.publish(source, 'owner-stable');
    const second = registry.publish(source, 'owner-stable');

    expect(second.revision).toBe(first.revision);
    expect(listener).toHaveBeenCalledOnce();
    expect(registry.owner(source)).toBe('owner-stable');
  });

  it('emits a revisioned removal when the last tab or source retires', async () => {
    const registry = new BrowserStateProjectionRegistry();
    const owner = acquireSessionBrowser('owner-a');
    const tab = await owner.openTab();
    registry.publish(source, 'owner-a');
    tab.close();

    const removed = registry.publish(source, 'owner-a');

    expect(removed).toEqual({ source, revision: 2, snapshot: null });
    expect(registry.get(source)).toBeNull();
  });

  it('keeps Remote generations and sessions in distinct keys', () => {
    expect(browserStateSourceKey(source)).not.toBe(browserStateSourceKey({
      ...source, generation: 3,
    }));
    expect(browserStateSourceKey(source)).not.toBe(browserStateSourceKey({
      ...source, sessionId: 'session-b',
    }));
  });

  it('clears every source bound to one private owner without exposing the owner', async () => {
    const registry = new BrowserStateProjectionRegistry();
    await acquireSessionBrowser('owner-retired').openTab();
    const local = { kind: 'local' as const, sessionId: 'session-local' };
    registry.publish(local, 'owner-retired');
    registry.publish(source, 'owner-retired');

    registry.clearOwner('owner-retired');

    expect(registry.get(local)).toBeNull();
    expect(registry.get(source)).toBeNull();
  });
});
