import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const screenshots = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock('@main/browser-use/screenshot-store', () => ({
  persistBrowserScreenshot: screenshots.persist,
}));

import { BrowserEngine, setBrowserEngine } from '@main/browser-use/engine/registry';
import { fakeWindowFactory } from '@main/browser-use/engine/__tests__/_fakes';
import type { DesktopBrokerRequestDto } from '@contracts/index';
import {
  executeRemoteBrowserRequest,
  remoteBrowserOwnerId,
} from './remote-browser-executor';

function request(
  operation: DesktopBrokerRequestDto['operation'],
  args: DesktopBrokerRequestDto['args'],
): DesktopBrokerRequestDto {
  return {
    requestId: randomUUID(),
    sessionId: 'session-a',
    kind: 'browser',
    operation,
    args,
    leaseMs: 1_000,
  };
}

beforeEach(() => {
  setBrowserEngine(new BrowserEngine(fakeWindowFactory()));
  screenshots.persist.mockImplementation(async (_sessionId, _tabId, png: Buffer) => {
    const path = join(tmpdir(), `agent-deck-remote-browser-${randomUUID()}.png`);
    await writeFile(path, png);
    return path;
  });
});

describe('remote browser desktop execution', () => {
  it('reuses existing Browser handlers with source-qualified owner isolation', async () => {
    const ownerA = remoteBrowserOwnerId({
      profileId: 'profile-a', coreId: 'core-a', generation: null, sessionId: 'session-a',
    });
    const ownerB = remoteBrowserOwnerId({
      profileId: 'profile-a', coreId: 'core-a', generation: null, sessionId: 'session-b',
    });
    expect(ownerA).not.toBe(ownerB);

    const opened = await executeRemoteBrowserRequest(
      ownerA,
      request('browser_open', { url: 'localhost:3210' }),
    );
    expect(JSON.parse((opened.content[0] as { text: string }).text)).toMatchObject({
      tabId: 1,
      url: 'http://localhost:3210/',
    });
    const ownTabs = await executeRemoteBrowserRequest(ownerA, request('browser_tabs', {}));
    const otherTabs = await executeRemoteBrowserRequest(ownerB, request('browser_tabs', {}));
    expect(JSON.parse((ownTabs.content[0] as { text: string }).text).tabs).toHaveLength(1);
    expect(JSON.parse((otherTabs.content[0] as { text: string }).text).tabs).toEqual([]);
  });

  it('rejects desktop file URLs and never returns a desktop screenshot path', async () => {
    const owner = remoteBrowserOwnerId({
      profileId: 'profile-a', coreId: 'core-a', generation: 2, sessionId: 'session-a',
    });
    const denied = await executeRemoteBrowserRequest(
      owner,
      request('browser_open', { url: 'file:///Users/private/secret.html' }),
    );
    expect(denied.isError).toBe(true);
    expect((denied.content[0] as { text: string }).text).not.toContain('/Users/private');

    await executeRemoteBrowserRequest(owner, request('browser_open', { url: 'about:blank' }));
    const screenshot = await executeRemoteBrowserRequest(
      owner,
      request('browser_screenshot', { maxWidth: 800 }),
    );
    expect(screenshot.content.some((block) => block.type === 'image')).toBe(true);
    const summary = JSON.parse((screenshot.content[0] as { text: string }).text);
    expect(summary.desktopArtifact).toBe(true);
    expect(summary.savedPath).toBeUndefined();
    expect(JSON.stringify(screenshot)).not.toContain(tmpdir());
  });
});
