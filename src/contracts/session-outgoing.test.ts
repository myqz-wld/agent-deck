import { describe, expect, it } from 'vitest';
import {
  SESSION_OUTGOING_MAX_RESULT_BYTES,
  parseSessionOutgoingListResult,
  parseSessionOutgoingRemoveResult,
} from './session-outgoing';

describe('session outgoing contract', () => {
  it('keeps queue attachments path-free', () => {
    const parsed = parseSessionOutgoingListResult({
      sessionId: 'session-a', adapterId: 'claude-code', revision: 4,
      messages: [{
        id: 'message-a', text: 'hello',
        attachments: [{ id: 'message-a:0', mime: 'image/png', bytes: 10 }],
      }],
    });
    expect(parsed.messages[0]?.attachments[0]).toEqual({
      id: 'message-a:0', mime: 'image/png', bytes: 10,
    });
    expect(() => parseSessionOutgoingListResult({
      ...parsed,
      messages: [{ ...parsed.messages[0], attachments: [{
        id: 'message-a:0', mime: 'image/png', bytes: 10, path: '/private/image.png',
      }] }],
    })).toThrow();
  });

  it('parses an exact removal result', () => {
    expect(parseSessionOutgoingRemoveResult({ removed: true, revision: 5 }))
      .toEqual({ removed: true, revision: 5 });
  });

  it('rejects a queue response that exceeds the framed response budget', () => {
    expect(() => parseSessionOutgoingListResult({
      sessionId: 'session-a',
      adapterId: 'claude-code',
      revision: 4,
      messages: Array.from({ length: 64 }, (_, index) => ({
        id: `message-${index}`,
        text: 'x'.repeat(SESSION_OUTGOING_MAX_RESULT_BYTES / 64),
        attachments: [],
      })),
    })).toThrow(/result\.bytes/u);
  });
});
