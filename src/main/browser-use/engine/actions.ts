/**
 * Semantic browser actions.
 *
 * Fronts call these instead of driving CDP themselves. One call performs the whole orchestration —
 * resolve the reference, act, let the page settle, and return the cheapest useful state — because
 * adapters other than Codex have no client-side browser library to do that for them.
 */

import { EngineTab, delay } from './tab';
import {
  clickScript,
  evaluateScript,
  pressFallbackScript,
  scrollScript,
  selectorProbeScript,
  snapshotScript,
  typeScript,
} from './scripts';

export const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'file:', 'about:'] as const;

const KEY_CODES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

export interface PageState {
  url: string;
  title: string;
}

export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  // `localhost:3000` is a host and port, not a `localhost:` scheme. Anything whose colon is followed
  // by a digit is treated as host:port; everything else keeps its explicit scheme so the allow-list
  // below can reject it honestly instead of turning `javascript:` into `http://javascript:`.
  const looksSchemed =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z][a-zA-Z0-9.-]*:\d/.test(trimmed);
  const candidate = looksSchemed ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol as (typeof ALLOWED_URL_SCHEMES)[number])) {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol}". Allowed schemes: ${ALLOWED_URL_SCHEMES.join(', ')}.`,
    );
  }
  return parsed.toString();
}

export function pageState(tab: EngineTab): PageState {
  return { url: tab.url(), title: tab.title() };
}

export async function navigate(tab: EngineTab, rawUrl: string): Promise<PageState> {
  const url = normalizeUrl(rawUrl);
  await tab.loadUrl(url);
  await tab.waitForSettle();
  return pageState(tab);
}

export async function reload(tab: EngineTab): Promise<PageState> {
  await tab.reload();
  return pageState(tab);
}

export interface SnapshotResult {
  refGeneration: number;
  url: string;
  title: string;
  elementCount: number;
  eligibleElementCount: number;
  truncated: boolean;
  elements: Array<Record<string, unknown>>;
  coverage: OpenDomCoverage;
  text?: string;
}

export interface OpenDomCoverage {
  documents: number;
  sameOriginFrames: number;
  inaccessibleFrames: number;
  openShadowRoots: number;
  scannedElements: number;
  scanLimitReached: boolean;
}

export async function snapshot(
  tab: EngineTab,
  options: { limit?: number; includeText?: boolean; textLimit?: number } = {},
): Promise<SnapshotResult> {
  const raw = await runScript<string>(
    tab,
    snapshotScript({
      limit: options.limit ?? 120,
      includeText: options.includeText ?? false,
      textLimit: options.textLimit ?? 4_000,
    }),
  );
  return JSON.parse(raw) as SnapshotResult;
}

export async function click(tab: EngineTab, ref: string): Promise<Record<string, unknown>> {
  const result = await runScript<string>(tab, clickScript(ref));
  await tab.waitForSettle(2_000);
  return { ...(JSON.parse(result) as Record<string, unknown>), page: pageState(tab) };
}

export async function typeText(
  tab: EngineTab,
  ref: string,
  text: string,
  options: { clear?: boolean; submit?: boolean } = {},
): Promise<Record<string, unknown>> {
  const result = await runScript<string>(tab, typeScript(ref, text, options.clear ?? true));
  const parsed = JSON.parse(result) as Record<string, unknown>;
  if (options.submit === true) {
    await press(tab, 'Enter');
    await tab.waitForSettle(2_000);
  }
  return { ...parsed, submitted: options.submit === true, page: pageState(tab) };
}

export async function press(tab: EngineTab, key: string): Promise<Record<string, unknown>> {
  const keyCode = KEY_CODES[key.trim().toLowerCase()] ?? (key.length === 1 ? key : null);
  if (keyCode == null) {
    throw new Error(
      `Unsupported key "${key}". Use a single character or one of: ${Object.keys(KEY_CODES).join(', ')}.`,
    );
  }
  // A focused window takes real input events; a background tab must go through the script path,
  // which reproduces the native effect explicitly. Both are reported so a caller can tell them apart.
  if (tab.sendKey(keyCode)) {
    await delay(120);
    return { pressed: key, delivery: 'input-event', page: pageState(tab) };
  }
  const raw = await runScript<string>(tab, pressFallbackScript(key));
  await delay(120);
  return {
    ...(JSON.parse(raw) as Record<string, unknown>),
    delivery: 'script',
    page: pageState(tab),
  };
}

export async function scroll(
  tab: EngineTab,
  options: { ref?: string; to?: 'top' | 'bottom'; dx?: number; dy?: number } = {},
): Promise<Record<string, unknown>> {
  const raw = await runScript<string>(
    tab,
    scrollScript({
      ref: options.ref,
      to: options.to,
      dx: options.dx ?? 0,
      dy: options.dy ?? 600,
    }),
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function evaluate(tab: EngineTab, expression: string): Promise<Record<string, unknown>> {
  const raw = await runScript<string>(tab, evaluateScript(expression));
  return JSON.parse(raw) as Record<string, unknown>;
}

export interface ScreenshotResult {
  png: Buffer;
  fullPage: boolean;
}

export async function screenshot(
  tab: EngineTab,
  options: { fullPage?: boolean; maxWidth?: number } = {},
): Promise<ScreenshotResult> {
  if (options.fullPage === true) {
    const result = (await tab.cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })) as { data?: string };
    if (typeof result?.data === 'string') {
      return { png: Buffer.from(result.data, 'base64'), fullPage: true };
    }
  }
  return { png: await tab.capturePng(options.maxWidth), fullPage: false };
}

export async function readConsole(tab: EngineTab, limit: number): Promise<unknown[]> {
  await tab.cdp.enableConsoleCapture();
  return tab.cdp.readConsole(limit);
}

export async function readNetwork(tab: EngineTab, limit: number): Promise<unknown[]> {
  await tab.cdp.enableNetworkCapture();
  return tab.cdp.readNetwork(limit);
}

export type SelectorWaitState = 'attached' | 'visible' | 'hidden' | 'detached';

export interface SelectorWaitResult {
  kind: 'selector';
  selector: string;
  state: SelectorWaitState;
  count: number;
  visibleCount: number;
  elapsedMs: number;
  page: PageState;
}

export interface NetworkIdleWaitResult {
  kind: 'network-idle';
  idleMs: number;
  inFlight: number;
  elapsedMs: number;
  page: PageState;
}

interface SelectorProbe {
  count: number;
  visibleCount: number;
  coverage?: OpenDomCoverage;
}

export async function armNetworkTracking(tab: EngineTab): Promise<void> {
  await tab.cdp.enableNetworkTracking();
}

export async function waitForSelector(
  tab: EngineTab,
  selector: string,
  state: SelectorWaitState,
  timeoutMs: number,
): Promise<SelectorWaitResult> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastProbe: SelectorProbe = { count: 0, visibleCount: 0 };
  let lastTransientError = '';

  while (Date.now() <= deadline) {
    try {
      const raw = await runScript<string>(tab, selectorProbeScript(selector));
      lastProbe = JSON.parse(raw) as SelectorProbe;
      lastTransientError = '';
      if (selectorStateMatches(lastProbe, state)) {
        return {
          kind: 'selector',
          selector,
          state,
          ...lastProbe,
          elapsedMs: Date.now() - startedAt,
          page: pageState(tab),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Invalid CSS selector') || message.includes('is closed')) throw error;
      // A navigation can replace the execution context between polls. Keep waiting until the
      // caller's deadline instead of turning that expected transition into an immediate failure.
      lastTransientError = message;
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }

  const detail =
    lastTransientError.length > 0
      ? ` Last page error: ${lastTransientError}`
      : ` Last observed ${lastProbe.count} matching element(s), ${lastProbe.visibleCount} visible.${lastProbe.coverage?.scanLimitReached === true ? ' The bounded open-DOM scan limit was reached.' : ''}`;
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for selector ${JSON.stringify(selector)} to be ${state}.${detail}`,
  );
}

export async function waitForNetworkIdle(
  tab: EngineTab,
  timeoutMs: number,
  idleMs: number,
): Promise<NetworkIdleWaitResult> {
  await armNetworkTracking(tab);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastState = tab.cdp.networkActivityState();

  while (Date.now() <= deadline) {
    lastState = tab.cdp.networkActivityState();
    const now = Date.now();
    if (
      lastState.inFlight === 0
      && now - Math.max(lastState.lastActivityAt, startedAt - idleMs) >= idleMs
    ) {
      return {
        kind: 'network-idle',
        idleMs,
        inFlight: 0,
        elapsedMs: now - startedAt,
        page: pageState(tab),
      };
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${idleMs}ms of network idle; ${lastState.inFlight} request(s) are still in flight.`,
  );
}

function selectorStateMatches(probe: SelectorProbe, state: SelectorWaitState): boolean {
  if (state === 'attached') return probe.count > 0;
  if (state === 'visible') return probe.visibleCount > 0;
  // Absence cannot be proven when the bounded traversal stopped before covering the whole tree.
  if (probe.coverage?.scanLimitReached === true) return false;
  if (state === 'detached') return probe.count === 0;
  return probe.visibleCount === 0;
}

/**
 * Run an injected script and translate the page-side sentinel errors into guidance an agent can
 * act on without reading engine internals.
 */
async function runScript<T>(tab: EngineTab, script: string): Promise<T> {
  try {
    return await tab.executeJs<T>(script);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('NO_SNAPSHOT')) {
      throw new Error('No element references exist yet for this tab. Take a snapshot first.');
    }
    if (message.includes('STALE_REF')) {
      throw new Error(
        'That element reference is stale because the page changed or a newer snapshot replaced it. Take a fresh snapshot and use its refs.',
      );
    }
    if (message.includes('DETACHED_REF')) {
      throw new Error(
        'That element is no longer attached to the page. Take a fresh snapshot and use its refs.',
      );
    }
    if (message.includes('INVALID_SELECTOR:')) {
      const detail = message.split('INVALID_SELECTOR:').slice(1).join('INVALID_SELECTOR:').trim();
      throw new Error(`Invalid CSS selector: ${detail}`);
    }
    throw error instanceof Error ? error : new Error(message);
  }
}
