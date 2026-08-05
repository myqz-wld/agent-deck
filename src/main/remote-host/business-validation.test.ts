import { describe, expect, it } from 'vitest';

import { parseRemoteHostPendingListResult } from './business-validation';

function result(questionIds?: unknown) {
  return {
    requests: [{
      id: 'request-1',
      sessionId: 'session-1',
      kind: 'ask-user-question',
      status: 'pending',
      createdAt: 1,
      expiresAt: null,
      display: questionIds === undefined ? {} : { questionIds },
    }],
    revision: 2,
  };
}

describe('remote host pending result validation', () => {
  it('accepts missing questionIds for the authoritative answer fallback', () => {
    expect(parseRemoteHostPendingListResult(result(), 'session-1')).toMatchObject({
      requests: [{ display: {} }],
    });
  });

  it.each([
    { questionIds: [] },
    { questionIds: ['duplicate', 'duplicate'] },
    { questionIds: ['line\u0000break'] },
  ])('rejects malformed bounded questionIds: $questionIds', ({ questionIds }) => {
    expect(() => parseRemoteHostPendingListResult(
      result(questionIds),
      'session-1',
    )).toThrow('malformed question ids');
  });
});
