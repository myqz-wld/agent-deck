import { isJsonObject, type JsonObject } from './json';
import { SessionConsoleContractError } from './session-console-common';

export const DESKTOP_BROKER_BROWSER_OPERATIONS = Object.freeze([
  'browser_open',
  'browser_tabs',
  'browser_navigate',
  'browser_wait',
  'browser_close',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_read_console',
  'browser_read_network',
  'browser_evaluate',
] as const);

export type DesktopBrokerBrowserOperation =
  (typeof DESKTOP_BROKER_BROWSER_OPERATIONS)[number];

export const DESKTOP_BROKER_MAX_ARGUMENT_BYTES = 64 * 1024;
export const DESKTOP_BROKER_MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const DESKTOP_BROKER_MAX_WAIT_MS = 25_000;
export const DESKTOP_BROKER_MAX_LEASE_MS = 60_000;
export const DESKTOP_BROKER_MAX_CONTENT_BLOCKS = 4;
export const DESKTOP_BROKER_MAX_TEXT_BYTES = 256 * 1024;
export const DESKTOP_BROKER_MAX_IMAGE_BASE64_BYTES = 1_600_000;

export interface DesktopBrokerRequestDto {
  readonly requestId: string;
  readonly sessionId: string;
  readonly kind: 'browser';
  readonly operation: DesktopBrokerBrowserOperation;
  readonly args: JsonObject;
  /** Core-computed remaining execution lease; desktop enforces it on its local monotonic timer. */
  readonly leaseMs: number;
}

export interface DesktopBrokerNextParams {
  readonly waitMs: number;
}

export interface DesktopBrokerNextResult {
  readonly request: DesktopBrokerRequestDto | null;
  readonly revision: number;
}

export type DesktopBrokerContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: 'image/png' };

export interface DesktopBrokerToolResult {
  [key: string]: unknown;
  readonly content: DesktopBrokerContentBlock[];
  readonly isError?: boolean;
}

export interface DesktopBrokerRespondParams {
  readonly requestId: string;
  readonly result: DesktopBrokerToolResult;
}

export interface DesktopBrokerRespondResult {
  readonly accepted: true;
  readonly revision: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) fail(field);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function token(value: unknown, field: string): string {
  if (
    typeof value !== 'string' || value.length > 256 ||
    Buffer.byteLength(value) > 256 || !TOKEN.test(value)
  ) fail(field);
  return value;
}

function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(field);
  }
  return value as number;
}

function boundedJsonObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) fail(field);
  if (Buffer.byteLength(JSON.stringify(value)) > DESKTOP_BROKER_MAX_ARGUMENT_BYTES) fail(field);
  return value;
}

function contentBlock(value: unknown, index: number): DesktopBrokerContentBlock {
  const field = `desktop.broker.result.content.${index}`;
  const raw = object(value, field);
  if (raw.type === 'text') {
    exactKeys(raw, ['text', 'type'], field);
    if (
      typeof raw.text !== 'string' ||
      Buffer.byteLength(raw.text) > DESKTOP_BROKER_MAX_TEXT_BYTES
    ) fail(`${field}.text`);
    return { type: 'text', text: raw.text };
  }
  if (raw.type === 'image') {
    exactKeys(raw, ['data', 'mimeType', 'type'], field);
    if (
      raw.mimeType !== 'image/png' || typeof raw.data !== 'string' ||
      raw.data.length === 0 || raw.data.length > DESKTOP_BROKER_MAX_IMAGE_BASE64_BYTES ||
      !BASE64.test(raw.data)
    ) fail(`${field}.image`);
    return { type: 'image', data: raw.data, mimeType: 'image/png' };
  }
  return fail(`${field}.type`);
}

export function parseDesktopBrokerNextParams(value: unknown): DesktopBrokerNextParams {
  const raw = object(value, 'desktop.broker.next.params');
  exactKeys(raw, ['waitMs'], 'desktop.broker.next.params');
  const waitMs = integer(raw.waitMs, 'desktop.broker.next.waitMs', DESKTOP_BROKER_MAX_WAIT_MS);
  if (waitMs < 100) fail('desktop.broker.next.waitMs');
  return { waitMs };
}

export function parseDesktopBrokerRequest(value: unknown): DesktopBrokerRequestDto {
  const raw = object(value, 'desktop.broker.request');
  exactKeys(
    raw,
    ['args', 'kind', 'leaseMs', 'operation', 'requestId', 'sessionId'],
    'desktop.broker.request',
  );
  if (raw.kind !== 'browser') fail('desktop.broker.request.kind');
  if (!DESKTOP_BROKER_BROWSER_OPERATIONS.includes(
    raw.operation as DesktopBrokerBrowserOperation,
  )) fail('desktop.broker.request.operation');
  return {
    requestId: token(raw.requestId, 'desktop.broker.request.requestId'),
    sessionId: token(raw.sessionId, 'desktop.broker.request.sessionId'),
    kind: 'browser',
    operation: raw.operation as DesktopBrokerBrowserOperation,
    args: boundedJsonObject(raw.args, 'desktop.broker.request.args'),
    leaseMs: integer(raw.leaseMs, 'desktop.broker.request.leaseMs', DESKTOP_BROKER_MAX_LEASE_MS),
  };
}

export function parseDesktopBrokerNextResult(value: unknown): DesktopBrokerNextResult {
  const raw = object(value, 'desktop.broker.next.result');
  exactKeys(raw, ['request', 'revision'], 'desktop.broker.next.result');
  return {
    request: raw.request === null ? null : parseDesktopBrokerRequest(raw.request),
    revision: integer(raw.revision, 'desktop.broker.next.revision'),
  };
}

export function parseDesktopBrokerToolResult(value: unknown): DesktopBrokerToolResult {
  const raw = object(value, 'desktop.broker.result');
  const expected = ['content'];
  if (raw.isError !== undefined) expected.push('isError');
  exactKeys(raw, expected, 'desktop.broker.result');
  if (!Array.isArray(raw.content) || raw.content.length > DESKTOP_BROKER_MAX_CONTENT_BLOCKS) {
    fail('desktop.broker.result.content');
  }
  if (raw.isError !== undefined && typeof raw.isError !== 'boolean') {
    fail('desktop.broker.result.isError');
  }
  const content = raw.content.map(contentBlock);
  const result: DesktopBrokerToolResult = {
    content,
    ...(raw.isError === undefined ? {} : { isError: raw.isError }),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > DESKTOP_BROKER_MAX_RESULT_BYTES) {
    fail('desktop.broker.result.bytes');
  }
  return result;
}

export function parseDesktopBrokerRespondParams(value: unknown): DesktopBrokerRespondParams {
  const raw = object(value, 'desktop.broker.respond.params');
  exactKeys(raw, ['requestId', 'result'], 'desktop.broker.respond.params');
  return {
    requestId: token(raw.requestId, 'desktop.broker.respond.requestId'),
    result: parseDesktopBrokerToolResult(raw.result),
  };
}

export function parseDesktopBrokerRespondResult(value: unknown): DesktopBrokerRespondResult {
  const raw = object(value, 'desktop.broker.respond.result');
  exactKeys(raw, ['accepted', 'revision'], 'desktop.broker.respond.result');
  if (raw.accepted !== true) fail('desktop.broker.respond.accepted');
  return {
    accepted: true,
    revision: integer(raw.revision, 'desktop.broker.respond.revision'),
  };
}
