import { isJsonObject } from './json';

export const SESSION_MESSAGES_MAX_ITEMS = 100;
export const SESSION_MESSAGES_MAX_BODY_BYTES = 2_048;
export const SESSION_MESSAGES_MAX_RESULT_BYTES = 512 * 1024;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface SessionMessageDto {
  id: string;
  teamId: string | null;
  fromSessionId: string;
  fromTitle: string;
  toSessionId: string;
  toTitle: string;
  body: string;
  status: 'cancelled' | 'delivered' | 'delivering' | 'failed' | 'pending';
  statusReason: string | null;
  sentAt: number;
  deliveredAt: number | null;
  replyToMessageId: string | null;
}

export interface SessionMessagesListParams { sessionId: string; limit: number }
export interface SessionMessagesListResult {
  sessionId: string;
  messages: SessionMessageDto[];
  truncated: boolean;
  revision: number;
}

function fail(field: string): never { throw new Error(`${field} is invalid`); }
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) fail(field);
  return value;
}
function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || bytes(value) > 256) fail(field);
  return value;
}
function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || CONTROL.test(value) || bytes(value) > maximum) fail(field);
  return value;
}
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(field);
  return Number(value);
}
function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}
function nullableToken(value: unknown, field: string): string | null {
  return value === null ? null : token(value, field);
}

export function parseSessionMessagesListParams(value: unknown): SessionMessagesListParams {
  const raw = object(value, 'session.messages.list.params');
  exact(raw, ['limit', 'sessionId'], 'session.messages.list.params');
  const limit = integer(raw.limit, 'session.messages.list.limit');
  if (limit < 1 || limit > SESSION_MESSAGES_MAX_ITEMS) fail('session.messages.list.limit');
  return { sessionId: token(raw.sessionId, 'session.messages.list.sessionId'), limit };
}

function message(value: unknown, index: number): SessionMessageDto {
  const field = `session.messages.list.messages.${index}`;
  const raw = object(value, field);
  exact(raw, [
    'body', 'deliveredAt', 'fromSessionId', 'fromTitle', 'id', 'replyToMessageId',
    'sentAt', 'status', 'statusReason', 'teamId', 'toSessionId', 'toTitle',
  ], field);
  if (typeof raw.status !== 'string' ||
      !['cancelled', 'delivered', 'delivering', 'failed', 'pending'].includes(raw.status)) {
    fail(`${field}.status`);
  }
  return {
    id: token(raw.id, `${field}.id`),
    teamId: nullableToken(raw.teamId, `${field}.teamId`),
    fromSessionId: token(raw.fromSessionId, `${field}.fromSessionId`),
    fromTitle: text(raw.fromTitle, `${field}.fromTitle`, 512),
    toSessionId: token(raw.toSessionId, `${field}.toSessionId`),
    toTitle: text(raw.toTitle, `${field}.toTitle`, 512),
    body: text(raw.body, `${field}.body`, SESSION_MESSAGES_MAX_BODY_BYTES),
    status: raw.status as SessionMessageDto['status'],
    statusReason: raw.statusReason === null
      ? null : text(raw.statusReason, `${field}.statusReason`, 512),
    sentAt: integer(raw.sentAt, `${field}.sentAt`),
    deliveredAt: nullableInteger(raw.deliveredAt, `${field}.deliveredAt`),
    replyToMessageId: nullableToken(raw.replyToMessageId, `${field}.replyToMessageId`),
  };
}

export function parseSessionMessagesListResult(
  value: unknown,
  requestedSessionId?: string,
  requestedLimit = SESSION_MESSAGES_MAX_ITEMS,
): SessionMessagesListResult {
  if (bytes(JSON.stringify(value)) > SESSION_MESSAGES_MAX_RESULT_BYTES) {
    fail('session.messages.list.result.bytes');
  }
  const raw = object(value, 'session.messages.list.result');
  exact(raw, ['messages', 'revision', 'sessionId', 'truncated'], 'session.messages.list.result');
  const sessionId = token(raw.sessionId, 'session.messages.list.sessionId');
  if (requestedSessionId && sessionId !== requestedSessionId) fail('session.messages.list.sessionId');
  if (!Array.isArray(raw.messages) || raw.messages.length > requestedLimit ||
      typeof raw.truncated !== 'boolean') fail('session.messages.list.messages');
  const messages = raw.messages.map(message);
  if (new Set(messages.map((item) => item.id)).size !== messages.length ||
      messages.some((item) => item.fromSessionId !== sessionId && item.toSessionId !== sessionId)) {
    fail('session.messages.list.messages');
  }
  return {
    sessionId,
    messages,
    truncated: raw.truncated,
    revision: integer(raw.revision, 'session.messages.list.revision'),
  };
}
