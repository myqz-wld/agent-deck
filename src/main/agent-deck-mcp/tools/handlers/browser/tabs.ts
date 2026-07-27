/**
 * Tab lifecycle handlers: open, list, navigate, close.
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

export async function browserOpenHandler(
  args: BrowserToolArgs & { url?: string; newTab?: boolean; show?: boolean },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserOpen, ctx);
  if (isHandlerResult(owner)) return owner;
  try {
    const show = args.show === true;
    const tab =
      args.newTab === true
        ? await owner.handle.openTab({ show })
        : await owner.handle.ensureTab({ show });
    if (show) tab.show();
    // Arm lifecycle tracking before the optional first navigation. This is deliberately separate
    // from network-history recording, which still starts only at browser_read_network.
    await actions.armNetworkTracking(tab);
    const page = args.url == null ? actions.pageState(tab) : await actions.navigate(tab, args.url);
    owner.handle.markActive(tab.id);
    return pageOk({ tabId: tab.id, ...page, visible: show });
  } catch (error) {
    return browserErr(error);
  }
}

export function browserTabsHandler(_args: BrowserToolArgs, ctx: HandlerContext): HandlerResult {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserTabs, ctx);
  if (isHandlerResult(owner)) return owner;
  try {
    return pageOk({ tabs: owner.handle.listTabInfos() });
  } catch (error) {
    return browserErr(error);
  }
}

export async function browserNavigateHandler(
  args: BrowserToolArgs & { url?: string; reload?: boolean },
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserNavigate, ctx);
  if (isHandlerResult(owner)) return owner;
  const tab = requireTab(owner.handle, args.tabId);
  if (isHandlerResult(tab)) return tab;
  if (args.url == null && args.reload !== true) {
    return browserErr(new Error('Pass a url to navigate to, or reload:true to reload the page.'));
  }
  try {
    await actions.armNetworkTracking(tab);
    const page = args.url == null ? await actions.reload(tab) : await actions.navigate(tab, args.url);
    return pageOk({ tabId: tab.id, ...page, reloaded: args.url == null });
  } catch (error) {
    return browserErr(error);
  }
}

export function browserCloseHandler(
  args: BrowserToolArgs & { all?: boolean },
  ctx: HandlerContext,
): HandlerResult {
  const owner = resolveOwner(AGENT_DECK_TOOL_NAMES.browserClose, ctx);
  if (isHandlerResult(owner)) return owner;
  try {
    if (args.all === true) {
      const closed = owner.handle.listTabs().map((tab) => tab.id);
      owner.handle.keepOnly([]);
      return pageOk({ closed });
    }
    const tab = requireTab(owner.handle, args.tabId);
    if (isHandlerResult(tab)) return tab;
    const closedId = tab.id;
    owner.handle.closeTab(closedId);
    return pageOk({ closed: [closedId], remaining: owner.handle.listTabInfos() });
  } catch (error) {
    return browserErr(error);
  }
}
