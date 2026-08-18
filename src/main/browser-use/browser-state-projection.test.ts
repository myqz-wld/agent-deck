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
    const first = await owner.openTab();

    const opened = registry.publish(source, 'opaque-desktop-owner');
    owner.markActive(first.id);
    const updated = registry.publish(source, 'opaque-desktop-owner');

    expect(opened.snapshot).toMatchObject({
      protocolVersion: 1,
      revision: 1,
      source,
      tabs: [{ id: 1, active: true, viewportRevision: 1 }],
    });
    expect(updated.revision).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updated)).not.toContain('opaque-desktop-owner');
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
});
