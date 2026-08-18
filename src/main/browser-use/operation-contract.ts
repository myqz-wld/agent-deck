import { z } from 'zod';

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
} from './operation-schemas';

export const BROWSER_OPERATION_PROTOCOL_VERSION = 1 as const;

export const BROWSER_OPERATION_NAMES = Object.freeze([
  'open',
  'tabs',
  'navigate',
  'wait',
  'close',
  'snapshot',
  'screenshot',
  'click',
  'type',
  'press',
  'scroll',
  'console',
  'network',
  'evaluate',
] as const);

export type BrowserOperation = (typeof BROWSER_OPERATION_NAMES)[number];

const navigateArgs = z.object(BROWSER_NAVIGATE_SCHEMA).strict().superRefine((value, ctx) => {
  const hasUrl = value.url != null;
  const reload = value.reload === true;
  if (hasUrl === reload) {
    ctx.addIssue({
      code: 'custom',
      message: 'Pass exactly one of url or reload:true.',
    });
  }
});

const waitArgs = z.object(BROWSER_WAIT_SCHEMA).strict().superRefine((value, ctx) => {
  if (value.kind === 'selector') {
    if (value.selector == null) {
      ctx.addIssue({ code: 'custom', path: ['selector'], message: 'selector is required.' });
    }
    if (value.idleMs != null) {
      ctx.addIssue({ code: 'custom', path: ['idleMs'], message: 'idleMs is not valid.' });
    }
    return;
  }
  if (value.selector != null) {
    ctx.addIssue({ code: 'custom', path: ['selector'], message: 'selector is not valid.' });
  }
  if (value.state != null) {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'state is not valid.' });
  }
});

const closeArgs = z.object(BROWSER_CLOSE_SCHEMA).strict().superRefine((value, ctx) => {
  if (value.all === true && value.tabId != null) {
    ctx.addIssue({ code: 'custom', message: 'all and tabId are mutually exclusive.' });
  }
});

const scrollArgs = z.object(BROWSER_SCROLL_SCHEMA).strict().superRefine((value, ctx) => {
  const modes = [
    value.ref != null,
    value.to != null,
    value.dx != null || value.dy != null,
  ].filter(Boolean).length;
  if (modes > 1) {
    ctx.addIssue({ code: 'custom', message: 'ref, to, and delta modes are mutually exclusive.' });
  }
});

const ARG_SCHEMAS = {
  open: z.object(BROWSER_OPEN_SCHEMA).strict(),
  tabs: z.object(BROWSER_TABS_SCHEMA).strict(),
  navigate: navigateArgs,
  wait: waitArgs,
  close: closeArgs,
  snapshot: z.object(BROWSER_SNAPSHOT_SCHEMA).strict(),
  screenshot: z.object(BROWSER_SCREENSHOT_SCHEMA).strict(),
  click: z.object(BROWSER_CLICK_SCHEMA).strict(),
  type: z.object(BROWSER_TYPE_SCHEMA).strict(),
  press: z.object(BROWSER_PRESS_SCHEMA).strict(),
  scroll: scrollArgs,
  console: z.object(BROWSER_READ_CONSOLE_SCHEMA).strict(),
  network: z.object(BROWSER_READ_NETWORK_SCHEMA).strict(),
  evaluate: z.object(BROWSER_EVALUATE_SCHEMA).strict(),
} satisfies Record<BrowserOperation, z.ZodType>;

export type BrowserOperationArgsMap = {
  [Operation in BrowserOperation]: z.infer<(typeof ARG_SCHEMAS)[Operation]>;
};

export type BrowserOperationRequest<Operation extends BrowserOperation = BrowserOperation> = {
  [Name in Operation]: {
    readonly protocolVersion: typeof BROWSER_OPERATION_PROTOCOL_VERSION;
    readonly operation: Name;
    readonly args: BrowserOperationArgsMap[Name];
  };
}[Operation];

const requestBoundary = z.object({
  protocolVersion: z.literal(BROWSER_OPERATION_PROTOCOL_VERSION),
  operation: z.enum(BROWSER_OPERATION_NAMES),
  args: z.unknown(),
}).strict();

export function parseBrowserOperationArgs<Operation extends BrowserOperation>(
  operation: Operation,
  args: unknown,
): BrowserOperationArgsMap[Operation] {
  return ARG_SCHEMAS[operation].parse(args) as BrowserOperationArgsMap[Operation];
}

/** Parse one identity-free Browser request. Authentication is deliberately out of band. */
export function parseBrowserOperationRequest(value: unknown): BrowserOperationRequest {
  const request = requestBoundary.parse(value);
  return {
    protocolVersion: BROWSER_OPERATION_PROTOCOL_VERSION,
    operation: request.operation,
    args: parseBrowserOperationArgs(request.operation, request.args),
  } as BrowserOperationRequest;
}

export interface BrowserOperationArtifact {
  readonly name: string;
  readonly mimeType: 'image/png';
  readonly bytes: number;
  readonly path: string;
}

export interface BrowserOperationSuccess<Operation extends BrowserOperation = BrowserOperation> {
  readonly ok: true;
  readonly protocolVersion: typeof BROWSER_OPERATION_PROTOCOL_VERSION;
  readonly operation: Operation;
  readonly data: Record<string, unknown>;
  readonly artifacts: readonly BrowserOperationArtifact[];
}

export type BrowserOperationErrorCode =
  | 'invalid_request'
  | 'browser_context_unavailable'
  | 'browser_state_error'
  | 'unknown_tab'
  | 'tab_limit'
  | 'stale_ref'
  | 'operation_timeout'
  | 'page_operation_failed'
  | 'transport_unavailable'
  | 'internal_error';

export interface BrowserOperationError {
  readonly code: BrowserOperationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextAction: string;
}

export interface BrowserOperationFailure<Operation extends BrowserOperation = BrowserOperation> {
  readonly ok: false;
  readonly protocolVersion: typeof BROWSER_OPERATION_PROTOCOL_VERSION;
  readonly operation: Operation;
  readonly error: BrowserOperationError;
}

export type BrowserOperationEnvelope<Operation extends BrowserOperation = BrowserOperation> =
  | BrowserOperationSuccess<Operation>
  | BrowserOperationFailure<Operation>;

export function browserOperationSuccess<Operation extends BrowserOperation>(
  operation: Operation,
  data: Record<string, unknown>,
  artifacts: readonly BrowserOperationArtifact[] = [],
): BrowserOperationSuccess<Operation> {
  return {
    ok: true,
    protocolVersion: BROWSER_OPERATION_PROTOCOL_VERSION,
    operation,
    data,
    artifacts,
  };
}

export function browserOperationFailure<Operation extends BrowserOperation>(
  operation: Operation,
  error: BrowserOperationError,
): BrowserOperationFailure<Operation> {
  return {
    ok: false,
    protocolVersion: BROWSER_OPERATION_PROTOCOL_VERSION,
    operation,
    error,
  };
}

export const LEGACY_BROWSER_OPERATION_NAMES = Object.freeze({
  open: 'browser_open',
  tabs: 'browser_tabs',
  navigate: 'browser_navigate',
  wait: 'browser_wait',
  close: 'browser_close',
  snapshot: 'browser_snapshot',
  screenshot: 'browser_screenshot',
  click: 'browser_click',
  type: 'browser_type',
  press: 'browser_press',
  scroll: 'browser_scroll',
  console: 'browser_read_console',
  network: 'browser_read_network',
  evaluate: 'browser_evaluate',
} as const satisfies Record<BrowserOperation, string>);

export type LegacyBrowserOperation =
  (typeof LEGACY_BROWSER_OPERATION_NAMES)[BrowserOperation];

const OPERATION_BY_LEGACY_NAME = new Map<LegacyBrowserOperation, BrowserOperation>(
  Object.entries(LEGACY_BROWSER_OPERATION_NAMES).map(([operation, legacy]) => [
    legacy,
    operation as BrowserOperation,
  ]),
);

export function browserOperationFromLegacyName(name: LegacyBrowserOperation): BrowserOperation {
  const operation = OPERATION_BY_LEGACY_NAME.get(name);
  if (operation == null) throw new Error('Unsupported Browser operation.');
  return operation;
}
