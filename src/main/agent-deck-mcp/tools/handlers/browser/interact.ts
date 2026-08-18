/** MCP projections for semantic Browser interaction operations. */

import type { HandlerContext, HandlerResult } from '../../helpers';
import { executeMcpBrowserOperation, type BrowserToolArgs } from './shared';

export function browserClickHandler(
  args: BrowserToolArgs & { ref: string },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('click', args, ctx);
}

export function browserTypeHandler(
  args: BrowserToolArgs & { ref: string; text: string; clear?: boolean; submit?: boolean },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('type', args, ctx);
}

export function browserPressHandler(
  args: BrowserToolArgs & { key: string },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('press', args, ctx);
}

export function browserScrollHandler(
  args: BrowserToolArgs & { ref?: string; to?: 'top' | 'bottom'; dx?: number; dy?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return executeMcpBrowserOperation('scroll', args, ctx);
}
