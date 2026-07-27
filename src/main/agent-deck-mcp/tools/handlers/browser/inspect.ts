/**
 * Inspection handlers: snapshot, screenshot, evaluate, console, network.
 *
 * `browser_screenshot` is the only Agent Deck MCP tool that returns non-text content. It always
 * writes the PNG to disk and reports the path, then attaches the image inline when the payload is
 * small enough. Clients that cannot render inline images still get a usable artifact.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as actions from '@main/browser-use/engine/actions';
import { AGENT_DECK_TOOL_NAMES } from '@main/agent-deck-mcp/types';

import type { HandlerContext, HandlerResult } from '../../helpers';
import {
  UNTRUSTED_PAGE_CONTENT_NOTE,
  browserErr,
  isHandlerResult,
  pageOk,
  requireTab,
  resolveOwner,
  type BrowserToolArgs,
} from './shared';

/** Roughly 1.2 MB of PNG data. Larger captures are returned as a file path only. */
const MAX_INLINE_IMAGE_BASE64 = 1_600_000;
const DEFAULT_SCREENSHOT_MAX_WIDTH = 1_024;

export type ImageHandlerResult = {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export async function browserSnapshotHandler(
  args: BrowserToolArgs & { includeText?: boolean; limit?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserSnapshot, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    const result = await actions.snapshot(tab, {
      limit: args.limit,
      includeText: args.includeText,
    });
    return pageOk({ tabId: tab.id, ...result });
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserScreenshotHandler(
  args: BrowserToolArgs & { fullPage?: boolean; maxWidth?: number },
  ctx: HandlerContext,
): Promise<HandlerResult | ImageHandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserScreenshot, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    const { png, fullPage } = await actions.screenshot(tab, {
      fullPage: args.fullPage,
      maxWidth: args.maxWidth ?? DEFAULT_SCREENSHOT_MAX_WIDTH,
    });
    const savedPath = await persistScreenshot(owner.sessionId, tab.id, png);
    const base64 = png.toString('base64');
    const page = actions.pageState(tab);
    const summary = {
      tabId: tab.id,
      ...page,
      fullPage,
      bytes: png.byteLength,
      savedPath,
      inlineImage: base64.length <= MAX_INLINE_IMAGE_BASE64,
      note: UNTRUSTED_PAGE_CONTENT_NOTE,
    };
    const content: ImageHandlerResult['content'] = [
      { type: 'text', text: JSON.stringify(summary, null, 2) },
    ];
    if (summary.inlineImage) {
      content.push({ type: 'image', data: base64, mimeType: 'image/png' });
    }
    return { content };
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserEvaluateHandler(
  args: BrowserToolArgs & { expression: string },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserEvaluate, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    const result = await actions.evaluate(tab, args.expression);
    return pageOk({ tabId: tab.id, result, page: actions.pageState(tab) });
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserReadConsoleHandler(
  args: BrowserToolArgs & { limit?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserReadConsole, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    const entries = await actions.readConsole(tab, args.limit ?? 50);
    return pageOk({
      tabId: tab.id,
      entries,
      capturedSince: 'console capture starts at the first browser_read_console call for this tab',
    });
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserReadNetworkHandler(
  args: BrowserToolArgs & { limit?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserReadNetwork, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    const entries = await actions.readNetwork(tab, args.limit ?? 50);
    return pageOk({
      tabId: tab.id,
      entries,
      capturedSince: 'network capture starts at the first browser_read_network call for this tab',
    });
  } catch (error) {
    return browserErr(error);
  }
}

async function persistScreenshot(sessionId: string, tabId: number, png: Buffer): Promise<string> {
  const directory = join(tmpdir(), 'agent-deck-browser', sanitizeSegment(sessionId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `tab-${tabId}-${Date.now()}.png`);
  await writeFile(path, png, { mode: 0o600 });
  return path;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'session';
}
