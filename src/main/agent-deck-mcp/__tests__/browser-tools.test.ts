/**
 * Cross-adapter browser tool surface (plan cross-adapter-browser-engine-20260727).
 *
 * Covers the three things that make these tools safe to hand to every adapter: per-adapter
 * enablement, session-scoped tab ownership, and external-caller denial. Page mechanics themselves are
 * covered by the engine tests under `src/main/browser-use/engine/__tests__/`.
 */

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

// The MCP handler helpers pull in session-repo, which reaches Electron; mock it like the other
// agent-deck-mcp handler tests do.
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));

import { BrowserEngine, setBrowserEngine } from '@main/browser-use/engine/registry';
import {
  fakeWindowFactory,
  type FakeWindow,
} from '@main/browser-use/engine/__tests__/_fakes';
import { EXTERNAL_CALLER_ALLOWED, EXTERNAL_CALLER_SENTINEL } from '../types';
import { buildBrowserTools } from '../tools/browser-tools';
import type { HandlerContext } from '../tools/helpers';
import {
  browserCloseHandler,
  browserNavigateHandler,
  browserOpenHandler,
  browserTabsHandler,
} from '../tools/handlers/browser/tabs';
import { browserClickHandler } from '../tools/handlers/browser/interact';
import {
  browserReadConsoleHandler,
  browserScreenshotHandler,
  browserSnapshotHandler,
  browserWaitHandler,
} from '../tools/handlers/browser/inspect';

const EXPECTED_TOOL_NAMES = [
  'browser_open',
  'browser_tabs',
  'browser_navigate',
  'browser_wait',
  'browser_close',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_read_console',
  'browser_read_network',
  'browser_evaluate',
];

function sessionCtx(sessionId: string): HandlerContext {
  return { caller: { callerSessionId: sessionId, transport: 'in-process' } };
}

function externalCtx(): HandlerContext {
  return { caller: { callerSessionId: EXTERNAL_CALLER_SENTINEL, transport: 'stdio' } };
}

function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  const text = result.content.find((block) => block.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

let factory: ReturnType<typeof fakeWindowFactory>;

beforeEach(() => {
  factory = fakeWindowFactory();
  setBrowserEngine(new BrowserEngine(factory));
});

afterEach(() => {
  setBrowserEngine(null);
});

describe('browser tool registration', () => {
  const tool = (
    name: string,
    description: string,
    schema: unknown,
    handler: unknown,
    options?: unknown,
  ) => ({ name, description, inputSchema: schema, handler, options }) as any;
  const makeCtx = () => sessionCtx('sid-1');

  it('registers the full browser surface when the adapter profile enables it', () => {
    const tools = buildBrowserTools({ tool, makeCtx, enabled: true });

    expect(tools.map((entry) => entry.name)).toEqual(EXPECTED_TOOL_NAMES);
    expect(tools.every((entry) => entry.description.length > 80)).toBe(true);
  });

  it('registers nothing for adapters that own a native browser surface', () => {
    expect(buildBrowserTools({ tool, makeCtx, enabled: false })).toEqual([]);
  });

  it('denies every browser tool to external callers', () => {
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(EXTERNAL_CALLER_ALLOWED[name as keyof typeof EXTERNAL_CALLER_ALLOWED]).toBe(false);
    }
  });
});

describe('browser tool handlers', () => {
  it('opens a background tab and reports the loaded page', async () => {
    const result = await browserOpenHandler({ url: 'localhost:3456/health' }, sessionCtx('sid-1'));
    const window = factory.windows[0] as unknown as FakeWindow;

    expect(payload(result)).toMatchObject({
      tabId: 1,
      url: 'http://localhost:3456/health',
      visible: false,
    });
    expect(window.shown).toBe(false);
    expect(window.browserDebugger.sent[0]?.method).toBe('Network.enable');
    expect(window.browserDebugger.sendCommand.mock.invocationCallOrder[0]).toBeLessThan(
      window.loadURL.mock.invocationCallOrder.at(-1) as number,
    );
    expect(payload(result).note).toMatch(/untrusted data/);
  });

  it('shows the window only when the caller asks for it', async () => {
    await browserOpenHandler({ show: true }, sessionCtx('sid-1'));

    expect(factory.windows[0]?.shown).toBe(true);
  });

  it('reuses the session tab unless a new one is requested', async () => {
    await browserOpenHandler({}, sessionCtx('sid-1'));
    await browserOpenHandler({}, sessionCtx('sid-1'));
    expect(factory.windows).toHaveLength(1);

    await browserOpenHandler({ newTab: true }, sessionCtx('sid-1'));
    expect(factory.windows).toHaveLength(2);
  });

  it('keeps tabs private to the owning session', async () => {
    await browserOpenHandler({ url: 'localhost:3000' }, sessionCtx('sid-1'));

    expect(payload(browserTabsHandler({}, sessionCtx('sid-2'))).tabs).toEqual([]);
    // A foreign tab id is not addressable either.
    const stolen = await browserNavigateHandler({ tabId: 1, url: 'localhost:9999' }, sessionCtx('sid-2'));
    expect(stolen.isError).toBe(true);
    expect(payload(stolen).error).toMatch(/Unknown browser tab 1/);
  });

  it('rejects external callers before touching the engine', async () => {
    const result = await browserOpenHandler({ url: 'localhost:3000' }, externalCtx());

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/not allowed for external caller/);
    expect(factory.windows).toHaveLength(0);
  });

  it('asks for a tab instead of silently opening one', async () => {
    const result = await browserSnapshotHandler({}, sessionCtx('sid-1'));

    expect(result.isError).toBe(true);
    expect(payload(result).hint).toMatch(/browser_open/);
    expect(factory.windows).toHaveLength(0);
  });

  it('returns snapshot refs and turns a stale ref into re-snapshot guidance', async () => {
    await browserOpenHandler({ url: 'localhost:3000' }, sessionCtx('sid-1'));
    const window = factory.windows[0] as unknown as FakeWindow;
    window.jsHandler = () =>
      JSON.stringify({
        refGeneration: 1,
        url: 'http://localhost:3000/',
        title: 'Test page',
        elementCount: 1,
        truncated: false,
        elements: [{ ref: '1-1', tag: 'button', name: 'Save' }],
      });

    const snapshot = await browserSnapshotHandler({}, sessionCtx('sid-1'));
    expect(payload(snapshot).elements[0]).toMatchObject({ ref: '1-1', name: 'Save' });

    window.jsHandler = () => {
      throw new Error('Error: STALE_REF');
    };
    const click = await browserClickHandler({ ref: '1-1' }, sessionCtx('sid-1'));
    expect(click.isError).toBe(true);
    expect(payload(click).hint).toMatch(/browser_snapshot again/);
  });

  it('writes screenshots to disk and inlines the image', async () => {
    await browserOpenHandler({ url: 'localhost:3000' }, sessionCtx('sid-1'));

    const result = await browserScreenshotHandler({}, sessionCtx('sid-1'));
    const summary = payload(result);

    expect(summary.savedPath.startsWith(tmpdir())).toBe(true);
    expect(summary.inlineImage).toBe(true);
    expect(result.content.some((block) => block.type === 'image')).toBe(true);
    await rm(summary.savedPath, { force: true });
  });

  it('enables console capture on first read', async () => {
    await browserOpenHandler({ url: 'localhost:3000' }, sessionCtx('sid-1'));

    const result = await browserReadConsoleHandler({ limit: 5 }, sessionCtx('sid-1'));

    expect(payload(result).entries).toEqual([]);
    expect((factory.windows[0] as unknown as FakeWindow).browserDebugger.attached).toBe(true);
  });

  it('waits for selector readiness and validates kind-specific arguments', async () => {
    await browserOpenHandler({ url: 'localhost:3000' }, sessionCtx('sid-1'));
    const window = factory.windows[0] as unknown as FakeWindow;
    window.jsHandler = () => JSON.stringify({ count: 1, visibleCount: 1 });

    const ready = await browserWaitHandler(
      { kind: 'selector', selector: '#ready', state: 'visible', timeoutMs: 500 },
      sessionCtx('sid-1'),
    );
    expect(payload(ready)).toMatchObject({
      kind: 'selector',
      selector: '#ready',
      state: 'visible',
      count: 1,
    });

    const invalid = await browserWaitHandler(
      { kind: 'network-idle', selector: '#ready' },
      sessionCtx('sid-1'),
    );
    expect(invalid.isError).toBe(true);
    expect(payload(invalid).error).toMatch(/only valid when kind is "selector"/);
  });

  it('rejects browser_wait for external callers before resolving a tab', async () => {
    const result = await browserWaitHandler(
      { kind: 'selector', selector: '#ready' },
      externalCtx(),
    );

    expect(result.isError).toBe(true);
    expect(payload(result).error).toMatch(/not allowed for external caller/);
    expect(factory.windows).toHaveLength(0);
  });

  it('closes every tab of the session on request', async () => {
    await browserOpenHandler({}, sessionCtx('sid-1'));
    await browserOpenHandler({ newTab: true }, sessionCtx('sid-1'));

    const result = browserCloseHandler({ all: true }, sessionCtx('sid-1'));

    expect(payload(result).closed).toEqual([1, 2]);
    expect(factory.windows.every((window) => window.destroyed)).toBe(true);
  });
});
