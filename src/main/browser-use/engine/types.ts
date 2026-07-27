/**
 * Provider-neutral browser engine contracts.
 *
 * The engine owns Electron windows, their CDP connection, and semantic page actions. It knows
 * nothing about Codex, MCP, or any adapter protocol: those live in `../fronts/*` and in the
 * Agent Deck MCP browser tools. Keeping this file protocol-free is what makes one browser usable
 * from every adapter.
 */

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/**
 * Ownership namespace. `codex-pipe` keeps the OpenAI Browser plugin's session identity separate
 * from `session`, which is keyed by an Agent Deck session id, so the two fronts can never see or
 * dispose each other's tabs.
 */
export type BrowserOwnerKind = 'codex-pipe' | 'session';

export interface BrowserOwnerKey {
  kind: BrowserOwnerKind;
  id: string;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface CreateTabOptions {
  /** Show and focus the window. Defaults to the engine's `showWindows` option. */
  show?: boolean;
}

export type CdpMessageListener = (
  method: string,
  params: Record<string, unknown>,
  /** Child-target session id. Always `undefined` for top-level page traffic. */
  cdpSessionId: string | undefined,
) => void;

export type CdpDetachListener = (reason: string) => void;

export interface BrowserEngineOptions {
  /** Window factory seam for tests. Production uses `new BrowserWindow(...)`. */
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  /** Default visibility for new tabs. Fronts may override per tab. */
  showWindows?: boolean;
  /** Window title for engine-owned windows. */
  windowTitle?: string;
  maxTabsPerOwner?: number;
  maxTotalTabs?: number;
}

export const DEFAULT_MAX_TABS_PER_OWNER = 8;
export const DEFAULT_MAX_TOTAL_TABS = 24;
export const DEFAULT_WINDOW_TITLE = 'Agent Deck In-app Browser';
export const INITIAL_URL = 'about:blank';
export const CDP_TIMEOUT_MS = 20_000;

/** Thrown when a per-owner or global tab cap would be exceeded. */
export class BrowserTabLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserTabLimitError';
  }
}
