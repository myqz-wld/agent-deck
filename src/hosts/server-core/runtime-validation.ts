import {
  AgentDeckClientErrorCode,
  isJsonObject,
  isJsonValue,
  parseSessionConsoleAttachments,
  type SessionConsoleAttachmentInput,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import { DaemonRequestError } from '@hosts/daemon';

const MAX_IDENTIFIER_BYTES = 256;
const MAX_CURSOR_BYTES = 512;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_RUNTIME_FIELDS = 16;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

export interface ServerCoreHistoryParams {
  readonly sessionId: string;
  readonly offset: number;
  readonly limit: number;
}

export interface ServerCoreSendParams {
  readonly sessionId: string;
  readonly text: string;
  readonly attachments: SessionConsoleAttachmentInput[];
}

export interface ServerCorePendingResponseParams {
  readonly sessionId: string;
  readonly requestId: string;
  readonly action: 'accept' | 'approve' | 'deny' | 'reject' | 'submit';
  readonly value?: JsonValue;
}

function invalid(): never {
  throw new DaemonRequestError(
    AgentDeckClientErrorCode.InvalidRequest,
    'Request parameters are invalid',
  );
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) invalid();
}

function token(value: unknown, maximumBytes = MAX_IDENTIFIER_BYTES): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value) > maximumBytes || !TOKEN.test(value)
  ) invalid();
  return value;
}

function text(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value) > MAX_TEXT_BYTES || CONTROL.test(value)
  ) invalid();
  return value;
}

function boundedJson(value: unknown): JsonValue {
  if (!isJsonValue(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_JSON_BYTES) invalid();
  return value;
}

export function parseEmptyParams(params: JsonObject): Record<string, never> {
  exactKeys(params, []);
  return {};
}

export function parseSessionTargetParams(params: JsonObject): { sessionId: string } {
  exactKeys(params, ['sessionId']);
  return { sessionId: token(params.sessionId) };
}

export function parseHistoryParams(params: JsonObject): ServerCoreHistoryParams {
  exactKeys(params, ['sessionId'], ['cursor', 'limit']);
  const limit = params.limit === undefined ? 50 : params.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) <= 0 || Number(limit) > MAX_PAGE_SIZE) {
    invalid();
  }
  let offset = 0;
  if (params.cursor !== undefined) {
    const value = token(params.cursor, MAX_CURSOR_BYTES);
    const match = /^v1:history:([1-9][0-9]{0,8})$/.exec(value);
    if (!match) invalid();
    offset = Number(match[1]);
    if (!Number.isSafeInteger(offset)) invalid();
  }
  return { sessionId: token(params.sessionId), offset, limit: Number(limit) };
}

export function historyCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset <= 0) invalid();
  return `v1:history:${offset}`;
}

export function parseSendParams(params: JsonObject): ServerCoreSendParams {
  exactKeys(params, ['sessionId', 'text'], ['attachments']);
  let attachments: SessionConsoleAttachmentInput[];
  try { attachments = parseSessionConsoleAttachments(params.attachments ?? []); }
  catch { return invalid(); }
  if (
    typeof params.text !== 'string' || Buffer.byteLength(params.text) > MAX_TEXT_BYTES ||
    CONTROL.test(params.text) || (params.text.trim().length === 0 && attachments.length === 0)
  ) invalid();
  return { sessionId: token(params.sessionId), text: params.text, attachments };
}

export function parseSteerParams(params: JsonObject): ServerCoreSendParams {
  exactKeys(params, ['sessionId', 'text']);
  return { sessionId: token(params.sessionId), text: text(params.text), attachments: [] };
}

export function parsePendingResponseParams(
  params: JsonObject,
): ServerCorePendingResponseParams {
  exactKeys(params, ['action', 'requestId', 'sessionId'], ['value']);
  if (
    typeof params.action !== 'string' ||
    !['accept', 'approve', 'deny', 'reject', 'submit'].includes(params.action)
  ) invalid();
  return {
    sessionId: token(params.sessionId),
    requestId: token(params.requestId),
    action: params.action as ServerCorePendingResponseParams['action'],
    ...(params.value === undefined ? {} : { value: boundedJson(params.value) }),
  };
}

export function parseRuntimeUpdateParams(
  params: JsonObject,
): { sessionId: string; patch: JsonObject } {
  exactKeys(params, ['patch', 'sessionId']);
  if (!isJsonObject(params.patch)) invalid();
  const keys = Object.keys(params.patch);
  if (keys.length === 0 || keys.length > MAX_RUNTIME_FIELDS) invalid();
  boundedJson(params.patch);
  return { sessionId: token(params.sessionId), patch: params.patch };
}

export function parseSubscriptionParams(
  params: JsonObject,
): { sessionId: string; subscribed: boolean } {
  exactKeys(params, ['sessionId', 'subscribed']);
  if (typeof params.subscribed !== 'boolean') invalid();
  return { sessionId: token(params.sessionId), subscribed: params.subscribed };
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
