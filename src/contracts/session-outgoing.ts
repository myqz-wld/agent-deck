import { isJsonObject } from './json';

export const SESSION_OUTGOING_MAX_ITEMS = 64;
export const SESSION_OUTGOING_MAX_ATTACHMENTS = 4;
export const SESSION_OUTGOING_MAX_TEXT_BYTES = 32 * 1024;
export const SESSION_OUTGOING_MAX_RESULT_BYTES = 2 * 1024 * 1024;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;
const MIME = /^image\/[A-Za-z0-9.+-]+$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface SessionOutgoingAttachmentDto { id: string; mime: string; bytes: number }
export interface SessionOutgoingMessageDto {
  id: string;
  text: string;
  attachments: SessionOutgoingAttachmentDto[];
}
export interface SessionOutgoingListParams { sessionId: string }
export interface SessionOutgoingListResult {
  sessionId: string;
  adapterId: string;
  messages: SessionOutgoingMessageDto[];
  revision: number;
}
export interface SessionOutgoingRemoveParams { sessionId: string; messageId: string }
export interface SessionOutgoingRemoveResult { removed: boolean; revision: number }

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
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(field);
  return Number(value);
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || CONTROL.test(value) || bytes(value) > SESSION_OUTGOING_MAX_TEXT_BYTES) {
    fail(field);
  }
  return value;
}

export function parseSessionOutgoingListParams(value: unknown): SessionOutgoingListParams {
  const raw = object(value, 'session.outgoing.list.params');
  exact(raw, ['sessionId'], 'session.outgoing.list.params');
  return { sessionId: token(raw.sessionId, 'session.outgoing.list.sessionId') };
}

export function parseSessionOutgoingRemoveParams(value: unknown): SessionOutgoingRemoveParams {
  const raw = object(value, 'session.outgoing.remove.params');
  exact(raw, ['messageId', 'sessionId'], 'session.outgoing.remove.params');
  return {
    sessionId: token(raw.sessionId, 'session.outgoing.remove.sessionId'),
    messageId: token(raw.messageId, 'session.outgoing.remove.messageId'),
  };
}

export function parseSessionOutgoingListResult(value: unknown): SessionOutgoingListResult {
  if (bytes(JSON.stringify(value)) > SESSION_OUTGOING_MAX_RESULT_BYTES) {
    fail('session.outgoing.list.result.bytes');
  }
  const raw = object(value, 'session.outgoing.list.result');
  exact(raw, ['adapterId', 'messages', 'revision', 'sessionId'], 'session.outgoing.list.result');
  if (!Array.isArray(raw.messages) || raw.messages.length > SESSION_OUTGOING_MAX_ITEMS) {
    fail('session.outgoing.list.messages');
  }
  const messages = raw.messages.map((value, index): SessionOutgoingMessageDto => {
    const field = `session.outgoing.list.messages.${index}`;
    const message = object(value, field);
    exact(message, ['attachments', 'id', 'text'], field);
    if (!Array.isArray(message.attachments) ||
        message.attachments.length > SESSION_OUTGOING_MAX_ATTACHMENTS) fail(`${field}.attachments`);
    return {
      id: token(message.id, `${field}.id`),
      text: text(message.text, `${field}.text`),
      attachments: message.attachments.map((value, attachmentIndex) => {
        const attachment = object(value, `${field}.attachments.${attachmentIndex}`);
        exact(attachment, ['bytes', 'id', 'mime'], `${field}.attachments.${attachmentIndex}`);
        if (typeof attachment.mime !== 'string' || !MIME.test(attachment.mime) ||
            bytes(attachment.mime) > 128) fail(`${field}.attachments.${attachmentIndex}.mime`);
        return {
          id: token(attachment.id, `${field}.attachments.${attachmentIndex}.id`),
          mime: attachment.mime,
          bytes: integer(attachment.bytes, `${field}.attachments.${attachmentIndex}.bytes`),
        };
      }),
    };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    fail('session.outgoing.list.messages');
  }
  return {
    sessionId: token(raw.sessionId, 'session.outgoing.list.sessionId'),
    adapterId: token(raw.adapterId, 'session.outgoing.list.adapterId'),
    messages,
    revision: integer(raw.revision, 'session.outgoing.list.revision'),
  };
}

export function parseSessionOutgoingRemoveResult(value: unknown): SessionOutgoingRemoveResult {
  const raw = object(value, 'session.outgoing.remove.result');
  exact(raw, ['removed', 'revision'], 'session.outgoing.remove.result');
  if (typeof raw.removed !== 'boolean') fail('session.outgoing.remove.removed');
  return { removed: raw.removed, revision: integer(raw.revision, 'session.outgoing.remove.revision') };
}
