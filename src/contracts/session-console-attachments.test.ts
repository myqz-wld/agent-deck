import { describe, expect, it } from 'vitest';

import {
  SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES,
  parseSessionConsoleAttachments,
} from './session-console-attachments';

function image(bytes: Uint8Array, mime = 'image/png') {
  return {
    kind: 'image',
    base64: Buffer.from(bytes).toString('base64'),
    mime,
    bytes: bytes.byteLength,
  };
}

describe('session console inline attachments', () => {
  it('accepts canonical bounded image envelopes', () => {
    const valid = image(Uint8Array.from([1, 2, 3]));
    expect(parseSessionConsoleAttachments([valid])).toEqual([valid]);
    expect(parseSessionConsoleAttachments([])).toEqual([]);
  });

  it('rejects malformed base64, byte mismatches, MIME widening, and extra fields', () => {
    const valid = image(Uint8Array.from([1, 2, 3]));
    expect(() => parseSessionConsoleAttachments([{ ...valid, base64: '***=' }]))
      .toThrow('attachments[0]');
    expect(() => parseSessionConsoleAttachments([{ ...valid, bytes: 2 }]))
      .toThrow('attachments[0]');
    expect(() => parseSessionConsoleAttachments([{ ...valid, mime: 'image/svg+xml' }]))
      .toThrow('attachments[0]');
    expect(() => parseSessionConsoleAttachments([{ ...valid, path: '/tmp/image.png' }]))
      .toThrow('attachments[0]');
  });

  it('rejects aggregate payloads above the transport-safe ceiling', () => {
    const half = new Uint8Array(SESSION_CONSOLE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES / 2 + 1);
    expect(() => parseSessionConsoleAttachments([image(half), image(half)]))
      .toThrow('attachments');
  });
});
