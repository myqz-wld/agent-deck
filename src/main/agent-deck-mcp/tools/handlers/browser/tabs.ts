/** MCP projections for Browser tab lifecycle operations. */

import type { HandlerContext, HandlerResult } from '../../helpers';
import { executeMcpBrowserOperation, type BrowserToolArgs } from './shared';

export function browserOpenHandler(
  args: BrowserToolArgs & { url?: string; newTab?: boolean; show?: boolean },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('open', args, ctx);
}

export function browserTabsHandler(
  args: Record<string, never>,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('tabs', args, ctx);
}

export function browserNavigateHandler(
  args: BrowserToolArgs & { url?: string; reload?: boolean },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('navigate', args, ctx);
}

export function browserCloseHandler(
  args: BrowserToolArgs & { all?: boolean },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('close', args, ctx);
}
