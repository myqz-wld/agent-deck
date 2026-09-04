/**
 * Provider-neutral browser engine contracts.
 *
 * The engine owns Electron windows, their CDP connection, and semantic page actions. It knows
 * nothing about an adapter protocol; the session-scoped CLI and Remote broker provide those
 * boundaries. Keeping this file protocol-free makes one browser usable from every adapter.
 */

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { EngineTabSurface } from './surface';

export interface BrowserOwnerKey {
  kind: 'session';
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

export interface BrowserEngineOptions {
  /** Window factory seam for tests. Production uses `new BrowserWindow(...)`. */
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  /** Production WebContentsView surface factory. Tests may retain createWindow during migration. */
  createSurface?: (options: {
    partition: string;
    title: string;
  }) => EngineTabSurface;
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
