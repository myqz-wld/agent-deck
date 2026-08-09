import { isJsonObject, type JsonObject } from './json';
import { SessionConsoleContractError } from './session-console-common';

/** Inline limits leave headroom inside the negotiated 4 MiB JSON frame after base64 expansion. */
export const SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT = 4;
export const SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const);

export interface SessionConsoleAttachmentInput extends JsonObject {
  kind: 'image';
  base64: string;
  mime: (typeof SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES)[number];
  bytes: number;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function decodedBytes(value: string): number {
  if (!value || value.length % 4 !== 0 || !BASE64.test(value)) return -1;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function parseSessionConsoleAttachments(
  value: unknown,
  field = 'session.console.create.attachments',
): SessionConsoleAttachmentInput[] {
  if (!Array.isArray(value) || value.length > SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_COUNT) {
    fail(field);
  }
  let total = 0;
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    if (!isJsonObject(entry)) fail(itemField);
    exactKeys(entry, ['base64', 'bytes', 'kind', 'mime'], itemField);
    if (
      entry.kind !== 'image' || typeof entry.base64 !== 'string' ||
      typeof entry.mime !== 'string' ||
      !SESSION_CONSOLE_REMOTE_ATTACHMENT_MIME_TYPES.includes(
        entry.mime as SessionConsoleAttachmentInput['mime'],
      ) ||
      !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0 ||
      (entry.bytes as number) > SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_BYTES ||
      decodedBytes(entry.base64) !== entry.bytes
    ) fail(itemField);
    total += entry.bytes as number;
    if (total > SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES) fail(field);
    return {
      kind: 'image',
      base64: entry.base64,
      mime: entry.mime as SessionConsoleAttachmentInput['mime'],
      bytes: entry.bytes as number,
    };
  });
}
