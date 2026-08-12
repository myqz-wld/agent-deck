import { describe, expect, it } from 'vitest';
import { parseSessionMessagesListResult } from './session-messages';

const message = {
  id: 'message-a', teamId: null, fromSessionId: 'session-a', fromTitle: 'A',
  toSessionId: 'session-b', toTitle: 'B', body: 'hello', status: 'delivered',
  statusReason: null, sentAt: 1, deliveredAt: 2, replyToMessageId: null,
} as const;

describe('session messages contract', () => {
  it('accepts bounded messages tied to the requested session', () => {
    expect(parseSessionMessagesListResult({
      sessionId: 'session-a', messages: [message], truncated: false, revision: 3,
    }, 'session-a', 10).messages).toEqual([message]);
  });

  it('rejects unrelated, extra-field, and oversized message rows', () => {
    expect(() => parseSessionMessagesListResult({
      sessionId: 'session-c', messages: [message], truncated: false, revision: 3,
    }, 'session-c', 10)).toThrow();
    expect(() => parseSessionMessagesListResult({
      sessionId: 'session-a', messages: [{ ...message, raw: 'secret' }],
      truncated: false, revision: 3,
    }, 'session-a', 10)).toThrow();
    expect(() => parseSessionMessagesListResult({
      sessionId: 'session-a', messages: [{ ...message, body: 'x'.repeat(2_049) }],
      truncated: false, revision: 3,
    }, 'session-a', 10)).toThrow();
  });
});
