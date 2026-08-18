/** MCP projections for Browser inspection and wait operations. */

import { persistBrowserScreenshot } from '@main/browser-use/screenshot-store';
import {
  BROWSER_OPERATION_PROTOCOL_VERSION,
} from '@main/browser-use/operation-contract';
import { executeBrowserOperation } from '@main/browser-use/operation-executor';

import type { HandlerContext, HandlerResult } from '../../helpers';
import {
  executeMcpBrowserOperation,
  isHandlerResult,
  projectBrowserExecution,
  resolveOwner,
  type BrowserToolArgs,
} from './shared';

const MAX_INLINE_IMAGE_BASE64 = 1_600_000;
const MAX_INLINE_IMAGE_BYTES = Math.floor((MAX_INLINE_IMAGE_BASE64 * 3) / 4);

export type ImageHandlerResult = {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export function browserSnapshotHandler(
  args: BrowserToolArgs & { includeText?: boolean; limit?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('snapshot', args, ctx);
}

export async function browserScreenshotHandler(
  args: BrowserToolArgs & { fullPage?: boolean; maxWidth?: number },
  ctx: HandlerContext,
): Promise<HandlerResult | ImageHandlerResult> {
  const owner = resolveOwner('screenshot', ctx);
  if (isHandlerResult(owner)) return owner;
  const result = await executeBrowserOperation(owner, {
    protocolVersion: BROWSER_OPERATION_PROTOCOL_VERSION,
    operation: 'screenshot',
    args,
  });
  if (!result.ok) return projectBrowserExecution(result);
  const image = result.binaryArtifacts[0];
  if (image == null) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'Browser screenshot response was missing image data.',
        hint: 'Close and reopen the Browser tab.',
      }) }],
      isError: true,
    };
  }
  const tabId = result.data.tabId;
  if (typeof tabId !== 'number') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'Browser screenshot response was invalid.',
        hint: 'Close and reopen the Browser tab.',
      }) }],
      isError: true,
    };
  }
  const savedPath = await persistBrowserScreenshot(owner.applicationSessionId, tabId, image.data);
  const inlineImage = image.data.byteLength <= MAX_INLINE_IMAGE_BYTES;
  const summary = { ...result.data, savedPath, inlineImage };
  const content: ImageHandlerResult['content'] = [
    { type: 'text', text: JSON.stringify(summary, null, 2) },
  ];
  if (inlineImage) {
    content.push({ type: 'image', data: image.data.toString('base64'), mimeType: 'image/png' });
  }
  return { content };
}

export function browserEvaluateHandler(
  args: BrowserToolArgs & { expression: string },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('evaluate', args, ctx);
}

export function browserReadConsoleHandler(
  args: BrowserToolArgs & { limit?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('console', args, ctx);
}

export function browserReadNetworkHandler(
  args: BrowserToolArgs & { limit?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('network', args, ctx);
}

export function browserWaitHandler(
  args: BrowserToolArgs & {
    kind: 'selector' | 'network-idle';
    selector?: string;
    state?: 'attached' | 'visible' | 'hidden' | 'detached';
    timeoutMs?: number;
    idleMs?: number;
  },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('wait', args, ctx);
}
