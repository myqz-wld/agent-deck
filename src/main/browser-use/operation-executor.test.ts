import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeWindowFactory, type FakeWindow } from './engine/__tests__/_fakes';
import { BrowserEngine, setBrowserEngine } from './engine/registry';
import { acquireSessionBrowser } from './session-browser';
import {
  executeBrowserOperation,
  type ResolvedBrowserOperationOwner,
} from './operation-executor';

function owner(applicationSessionId: string): ResolvedBrowserOperationOwner {
  return {
    applicationSessionId,
    handle: acquireSessionBrowser(applicationSessionId),
  };
}

let factory: ReturnType<typeof fakeWindowFactory>;

beforeEach(() => {
  factory = fakeWindowFactory();
  setBrowserEngine(new BrowserEngine(factory));
});

afterEach(() => setBrowserEngine(null));

describe('provider-neutral Browser operation executor', () => {
  it('uses only the already-resolved owner and keeps simultaneous owners isolated', async () => {
    const ownerA = owner('session-a');
    const ownerB = owner('session-b');
    const opened = await executeBrowserOperation(ownerA, {
      protocolVersion: 1,
      operation: 'open',
      args: { url: 'localhost:3210' },
    });
    const ownTabs = await executeBrowserOperation(ownerA, {
      protocolVersion: 1, operation: 'tabs', args: {},
    });
    const otherTabs = await executeBrowserOperation(ownerB, {
      protocolVersion: 1, operation: 'tabs', args: {},
    });

    expect(opened).toMatchObject({ ok: true, data: { tabId: 1 } });
    expect(ownTabs).toMatchObject({ ok: true, data: { tabs: [{ id: 1 }] } });
    expect(otherTabs).toMatchObject({ ok: true, data: { tabs: [] } });
    expect(JSON.stringify({ opened, ownTabs, otherTabs })).not.toContain('session-a');
  });

  it('returns stable stale-ref recovery without throwing transport-specific results', async () => {
    const resolved = owner('session-a');
    await executeBrowserOperation(resolved, {
      protocolVersion: 1, operation: 'open', args: {},
    });
    const window = factory.windows[0] as unknown as FakeWindow;
    window.jsHandler = () => {
      throw new Error('Error: STALE_REF');
    };

    const result = await executeBrowserOperation(resolved, {
      protocolVersion: 1, operation: 'click', args: { ref: '1-1' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'stale_ref',
        retryable: true,
        nextAction: 'Run agent-deck-browser snapshot again.',
      },
    });
  });

  it('keeps screenshot bytes in a private execution attachment, not JSON data', async () => {
    const resolved = owner('session-a');
    await executeBrowserOperation(resolved, {
      protocolVersion: 1, operation: 'open', args: {},
    });
    const result = await executeBrowserOperation(resolved, {
      protocolVersion: 1, operation: 'screenshot', args: { maxWidth: 800 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected screenshot success');
    expect(result.binaryArtifacts[0]).toMatchObject({
      name: 'browser-screenshot.png', mimeType: 'image/png',
    });
    expect(Buffer.isBuffer(result.binaryArtifacts[0]?.data)).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('Buffer');
  });
});
