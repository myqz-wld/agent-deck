import { describe, expect, it } from 'vitest';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { readMessageDeliveryRecoveryPayload } from '@shared/message-delivery-recovery';
import { safeStringifyPayload } from './payload-truncate';

function recovery(text: string) {
  return { role: 'system', error: true, text, messageDeliveryRecovery: {
    status: 'unknown', messageId: 'input-a', originalTextLength: text.length, attachmentCount: 1,
  }, attachments: [{ kind: 'uploaded', path: '/synthetic/image.png', mime: 'image/png', bytes: 1 }] };
}

describe('recovery payload persistence', () => {
  it.each(['界', '\u0001'])('retains maximum accepted input including CJK and JSON escapes (%j)', (character) => {
    const text = character.repeat(MAX_USER_MESSAGE_LENGTH);
    const original = recovery(text);
    const stored = JSON.parse(safeStringifyPayload(original));
    expect(stored).toEqual(original);
    expect(readMessageDeliveryRecoveryPayload(stored)?.text).toBe(text);
    expect(readMessageDeliveryRecoveryPayload(stored)?.textTruncated).toBe(false);
  });

  it('keeps ordinary output and oversized recovery-shaped values bounded', () => {
    const text = 'x'.repeat(MAX_USER_MESSAGE_LENGTH + 1);
    for (const payload of [{ role: 'assistant', text }, recovery(text),
      { ...recovery('small'), extra: 'x'.repeat(2 * 1024 * 1024) }]) {
      const stored = safeStringifyPayload(payload);
      expect(stored.length).toBeLessThan(256 * 1024);
    }
  });

  it('recognizes a projected partial recovery without treating it as complete text', () => {
    const projected = { ...recovery('long original text'), text: 'long' };
    expect(readMessageDeliveryRecoveryPayload(projected)?.textTruncated).toBe(true);
  });
});
