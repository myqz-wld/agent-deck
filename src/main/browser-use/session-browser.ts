/**
 * Session-owned browser helpers shared by Browser operations and the session lifecycle.
 *
 * Every Agent Deck session that opens a browser owns its tabs through its application session id,
 * which keeps one session from seeing another session's pages, cookies, or storage. Release is
 * idempotent and never creates a browser, so lifecycle call sites can call it unconditionally.
 */

import log from '@main/utils/logger';

import { getBrowserEngine } from './engine/registry';
import type { BrowserOwnerHandle } from './engine/registry';
import type { BrowserOwnerKey } from './engine/types';
import { revokeBrowserRuntimeOwner } from './browser-runtime-lifecycle';
import { getBrowserStateProjectionRegistry } from './browser-state-projection';

const logger = log.scope('browser-engine');

export function sessionBrowserOwner(sessionId: string): BrowserOwnerKey {
  return { kind: 'session', id: sessionId };
}

/** Acquire (creating on first use) the browser owner handle for an Agent Deck session. */
export function acquireSessionBrowser(sessionId: string): BrowserOwnerHandle {
  return getBrowserEngine().acquire(sessionBrowserOwner(sessionId));
}

/**
 * Close every browser window owned by a session. Safe to call for sessions that never opened one,
 * and safe to call twice; failures are logged instead of breaking a lifecycle transition.
 */
export async function disposeSessionBrowser(sessionId: string): Promise<void> {
  revokeBrowserRuntimeOwner(sessionId);
  getBrowserStateProjectionRegistry().clearOwner(sessionId);
  try {
    const engine = getBrowserEngine();
    if (engine.peek(sessionBrowserOwner(sessionId)) == null) return;
    await engine.disposeOwner(sessionBrowserOwner(sessionId));
    logger.debug(`[browser-engine] disposed browser tabs owned by session ${sessionId}`);
  } catch (err) {
    logger.warn(`[browser-engine] failed to dispose browser tabs for session ${sessionId}`, err);
  }
}
