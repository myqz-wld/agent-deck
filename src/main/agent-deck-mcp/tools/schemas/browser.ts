import { z } from 'zod';

import { SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';

/**
 * Browser tool schemas (cross-adapter in-app browser).
 *
 * Every browser tool is a write tool from the external-caller point of view: it needs a real Agent
 * Deck session identity to own its tabs, so `callerSessionId` always carries the write description
 * and external callers are rejected in `EXTERNAL_CALLER_ALLOWED`.
 *
 * Element targeting uses `ref` values produced by `browser_snapshot`, never CSS selectors. Refs are
 * tied to the snapshot that produced them, so a stale ref fails loudly instead of clicking the
 * wrong element after the page changed.
 */

const callerSessionId = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION);

const tabId = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'Tab to act on. Omit to use this session\'s current tab; the call fails when no tab is open yet.',
  );

const ref = z
  .string()
  .min(1)
  .max(64)
  .describe(
    'Element reference from the most recent browser_snapshot of this tab, such as "3-12". Never a CSS selector. Re-snapshot after the page changes; stale refs are rejected.',
  );

export const BROWSER_OPEN_SCHEMA = {
  url: z
    .string()
    .min(1)
    .max(2_048)
    .optional()
    .describe(
      'Optional URL to load right after opening. http, https, file, and about schemes only. A bare host such as localhost:3000 is treated as http.',
    ),
  newTab: z
    .boolean()
    .optional()
    .describe('Force a new tab instead of reusing this session\'s current tab. Defaults to false.'),
  show: z
    .boolean()
    .optional()
    .describe(
      'Show the browser window to the user. Defaults to false: keep browser work in the background unless the user asked to watch the page.',
    ),
  callerSessionId,
};

export const BROWSER_TABS_SCHEMA = { callerSessionId };

export const BROWSER_NAVIGATE_SCHEMA = {
  url: z
    .string()
    .min(1)
    .max(2_048)
    .optional()
    .describe('Target URL. Omit together with reload:true to reload the current page.'),
  reload: z
    .boolean()
    .optional()
    .describe('Reload the current page instead of navigating. Use after code changes without hot reload.'),
  tabId,
  callerSessionId,
};

export const BROWSER_CLOSE_SCHEMA = {
  tabId,
  all: z.boolean().optional().describe('Close every tab owned by this session.'),
  callerSessionId,
};

export const BROWSER_SNAPSHOT_SCHEMA = {
  tabId,
  includeText: z
    .boolean()
    .optional()
    .describe('Include the page visible text. Defaults to false; enable when you must read content, not act on it.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(400)
    .optional()
    .describe('Maximum interactive elements to return. Defaults to 120.'),
  callerSessionId,
};

export const BROWSER_SCREENSHOT_SCHEMA = {
  tabId,
  fullPage: z
    .boolean()
    .optional()
    .describe('Capture the full scrollable page instead of the viewport. Defaults to false.'),
  maxWidth: z
    .number()
    .int()
    .min(240)
    .max(2_560)
    .optional()
    .describe('Downscale the image to at most this width. Defaults to 1024 to keep the payload small.'),
  callerSessionId,
};

export const BROWSER_CLICK_SCHEMA = { ref, tabId, callerSessionId };

export const BROWSER_TYPE_SCHEMA = {
  ref,
  text: z.string().max(10_000).describe('Text to enter into the referenced field.'),
  clear: z
    .boolean()
    .optional()
    .describe('Replace the existing value instead of appending. Defaults to true.'),
  submit: z
    .boolean()
    .optional()
    .describe('Press Enter after typing. Defaults to false.'),
  tabId,
  callerSessionId,
};

export const BROWSER_PRESS_SCHEMA = {
  key: z
    .string()
    .min(1)
    .max(16)
    .describe('Key to press on the focused element, such as Enter, Tab, Escape, ArrowDown, or a single character.'),
  tabId,
  callerSessionId,
};

export const BROWSER_SCROLL_SCHEMA = {
  ref: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Scroll this referenced element into view. Takes precedence over to/dy.'),
  to: z
    .enum(['top', 'bottom'])
    .optional()
    .describe('Jump to the top or bottom of the page.'),
  dy: z
    .number()
    .int()
    .min(-20_000)
    .max(20_000)
    .optional()
    .describe('Vertical scroll delta in pixels. Defaults to 600 when no ref or to is given.'),
  dx: z
    .number()
    .int()
    .min(-20_000)
    .max(20_000)
    .optional()
    .describe('Horizontal scroll delta in pixels. Defaults to 0.'),
  tabId,
  callerSessionId,
};

export const BROWSER_READ_CONSOLE_SCHEMA = {
  tabId,
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum entries to return, newest last. Defaults to 50.'),
  callerSessionId,
};

export const BROWSER_READ_NETWORK_SCHEMA = {
  tabId,
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum entries to return, newest last. Defaults to 50.'),
  callerSessionId,
};

export const BROWSER_EVALUATE_SCHEMA = {
  expression: z
    .string()
    .min(1)
    .max(8_000)
    .describe(
      'JavaScript expression evaluated in the page. Awaited when it returns a promise. Prefer it for reading computed state that a snapshot does not expose.',
    ),
  tabId,
  callerSessionId,
};
