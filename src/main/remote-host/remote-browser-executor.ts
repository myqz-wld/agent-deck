import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import {
  parseDesktopBrokerToolResult,
  type DesktopBrokerBrowserOperation,
  type DesktopBrokerRequestDto,
  type DesktopBrokerToolResult,
} from '@contracts/index';
import type { HandlerContext } from '@main/agent-deck-mcp/tools/helpers';
import {
  BROWSER_CLICK_SCHEMA,
  BROWSER_CLOSE_SCHEMA,
  BROWSER_EVALUATE_SCHEMA,
  BROWSER_NAVIGATE_SCHEMA,
  BROWSER_OPEN_SCHEMA,
  BROWSER_PRESS_SCHEMA,
  BROWSER_READ_CONSOLE_SCHEMA,
  BROWSER_READ_NETWORK_SCHEMA,
  BROWSER_SCREENSHOT_SCHEMA,
  BROWSER_SCROLL_SCHEMA,
  BROWSER_SNAPSHOT_SCHEMA,
  BROWSER_TABS_SCHEMA,
  BROWSER_TYPE_SCHEMA,
  BROWSER_WAIT_SCHEMA,
} from '@main/agent-deck-mcp/tools/schemas/browser';
import {
  browserCloseHandler,
  browserNavigateHandler,
  browserOpenHandler,
  browserTabsHandler,
} from '@main/agent-deck-mcp/tools/handlers/browser/tabs';
import {
  browserClickHandler,
  browserPressHandler,
  browserScrollHandler,
  browserTypeHandler,
} from '@main/agent-deck-mcp/tools/handlers/browser/interact';
import {
  browserEvaluateHandler,
  browserReadConsoleHandler,
  browserReadNetworkHandler,
  browserScreenshotHandler,
  browserSnapshotHandler,
  browserWaitHandler,
} from '@main/agent-deck-mcp/tools/handlers/browser/inspect';
import { z } from 'zod';

type BrowserResult = {
  content: Array<
    { type: 'text'; text: string } |
    { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type BrowserHandler = (
  args: any,
  context: HandlerContext,
) => Promise<BrowserResult> | BrowserResult;

const SCHEMAS: Record<DesktopBrokerBrowserOperation, any> = {
  browser_open: BROWSER_OPEN_SCHEMA,
  browser_tabs: BROWSER_TABS_SCHEMA,
  browser_navigate: BROWSER_NAVIGATE_SCHEMA,
  browser_wait: BROWSER_WAIT_SCHEMA,
  browser_close: BROWSER_CLOSE_SCHEMA,
  browser_snapshot: BROWSER_SNAPSHOT_SCHEMA,
  browser_screenshot: BROWSER_SCREENSHOT_SCHEMA,
  browser_click: BROWSER_CLICK_SCHEMA,
  browser_type: BROWSER_TYPE_SCHEMA,
  browser_press: BROWSER_PRESS_SCHEMA,
  browser_scroll: BROWSER_SCROLL_SCHEMA,
  browser_read_console: BROWSER_READ_CONSOLE_SCHEMA,
  browser_read_network: BROWSER_READ_NETWORK_SCHEMA,
  browser_evaluate: BROWSER_EVALUATE_SCHEMA,
};

const HANDLERS: Record<DesktopBrokerBrowserOperation, BrowserHandler> = {
  browser_open: browserOpenHandler,
  browser_tabs: browserTabsHandler,
  browser_navigate: browserNavigateHandler,
  browser_wait: browserWaitHandler,
  browser_close: browserCloseHandler,
  browser_snapshot: browserSnapshotHandler,
  browser_screenshot: browserScreenshotHandler,
  browser_click: browserClickHandler,
  browser_type: browserTypeHandler,
  browser_press: browserPressHandler,
  browser_scroll: browserScrollHandler,
  browser_read_console: browserReadConsoleHandler,
  browser_read_network: browserReadNetworkHandler,
  browser_evaluate: browserEvaluateHandler,
};

export function remoteBrowserOwnerId(input: {
  readonly profileId: string;
  readonly coreId: string;
  readonly generation: number | null;
  readonly sessionId: string;
}): string {
  const framed = [input.profileId, input.coreId, String(input.generation), input.sessionId]
    .map((value) => `${Buffer.byteLength(value)}:${value}`).join('|');
  return `remote-browser-${createHash('sha256').update(framed).digest('hex')}`;
}

function remoteUrlAllowed(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  return !/^file:/i.test(value.trim());
}

function publicFailure(error: string, hint: string): DesktopBrokerToolResult {
  return parseDesktopBrokerToolResult({
    content: [{ type: 'text', text: JSON.stringify({ error, hint }) }],
    isError: true,
  });
}

async function sanitizeScreenshot(result: BrowserResult): Promise<DesktopBrokerToolResult> {
  const text = result.content.find((block) => block.type === 'text');
  const image = result.content.find((block) => block.type === 'image');
  if (!text || text.type !== 'text') {
    return publicFailure('Desktop screenshot response was invalid', 'Retry with a smaller maxWidth.');
  }
  let summary: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    summary = parsed as Record<string, unknown>;
  } catch {
    return publicFailure('Desktop screenshot response was invalid', 'Retry with a smaller maxWidth.');
  }
  const savedPath = typeof summary.savedPath === 'string' ? summary.savedPath : null;
  delete summary.savedPath;
  summary.desktopArtifact = true;
  if (savedPath) await rm(savedPath, { force: true }).catch(() => undefined);
  if (!image || image.type !== 'image') {
    return publicFailure(
      'Screenshot exceeded the remote inline transfer limit',
      'Retry with fullPage:false or a smaller maxWidth. Desktop paths are never exposed to Core.',
    );
  }
  return parseDesktopBrokerToolResult({
    content: [
      { type: 'text', text: JSON.stringify(summary, null, 2) },
      { type: 'image', data: image.data, mimeType: image.mimeType },
    ],
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  });
}

/** Executes one Core-authored browser request against a source-qualified desktop browser owner. */
export async function executeRemoteBrowserRequest(
  ownerId: string,
  request: DesktopBrokerRequestDto,
): Promise<DesktopBrokerToolResult> {
  const parsed = z.object(SCHEMAS[request.operation]).strict().safeParse(request.args);
  if (!parsed.success) {
    return publicFailure('Remote browser arguments were rejected', 'Refresh the tool schema and retry.');
  }
  if (
    (request.operation === 'browser_open' || request.operation === 'browser_navigate') &&
    !remoteUrlAllowed((parsed.data as { url?: unknown }).url)
  ) {
    return publicFailure(
      'Remote browser cannot open desktop file URLs',
      'Use http, https, about, or a local development server URL instead.',
    );
  }
  const context: HandlerContext = {
    caller: { callerSessionId: ownerId, transport: 'in-process' },
  };
  let result: BrowserResult;
  try {
    result = await HANDLERS[request.operation](parsed.data, context);
  } catch {
    return publicFailure('Desktop browser operation failed', 'Inspect the tab state and retry.');
  }
  if (request.operation === 'browser_screenshot') return sanitizeScreenshot(result);
  try {
    return parseDesktopBrokerToolResult(result);
  } catch {
    return publicFailure('Desktop browser response exceeded its safe boundary', 'Request less page data.');
  }
}
