/**
 * Interaction handlers: click, type, press, scroll.
 *
 * All targeting goes through snapshot refs, so these handlers never accept selectors and never need
 * to know about CDP node ids.
 */

import * as actions from '@main/browser-use/engine/actions';
import { AGENT_DECK_TOOL_NAMES } from '@main/agent-deck-mcp/types';

import type { HandlerContext, HandlerResult } from '../../helpers';
import {
  browserErr,
  isHandlerResult,
  pageOk,
  requireTab,
  resolveOwner,
  type BrowserToolArgs,
} from './shared';

export async function browserClickHandler(
  args: BrowserToolArgs & { ref: string },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserClick, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    return pageOk({ tabId: tab.id, ...(await actions.click(tab, args.ref)) });
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserTypeHandler(
  args: BrowserToolArgs & { ref: string; text: string; clear?: boolean; submit?: boolean },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserType, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    const result = await actions.typeText(tab, args.ref, args.text, {
      clear: args.clear,
      submit: args.submit,
    });
    return pageOk({ tabId: tab.id, ...result });
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserPressHandler(
  args: BrowserToolArgs & { key: string },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserPress, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    return pageOk({ tabId: tab.id, ...(await actions.press(tab, args.key)) });
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserScrollHandler(
  args: BrowserToolArgs & { ref?: string; to?: 'top' | 'bottom'; dx?: number; dy?: number },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserScroll, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  try {
    const result = await actions.scroll(tab, {
      ref: args.ref,
      to: args.to,
      dx: args.dx,
      dy: args.dy,
    });
    return pageOk({ tabId: tab.id, ...result });
  } catch (error) {
    return browserErr(error);
  }
}
