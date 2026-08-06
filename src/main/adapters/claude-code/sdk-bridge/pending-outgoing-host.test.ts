import { describe, expect, it } from 'vitest';

import { desktopClaudePendingOutgoingHost } from './pending-outgoing-host';
import { makeInternalSession } from './types';

describe('desktop Claude pending outgoing host', () => {
  it('keeps provider-echo tombstones bounded', () => {
    const internal = makeInternalSession({
      cwd: '/repo',
      applicationSid: 'session-a',
    });

    for (let index = 0; index < 33; index += 1) {
      desktopClaudePendingOutgoingHost.rememberIgnoredUserMessageId(
        internal,
        `provider-${index}`,
      );
    }

    expect(internal.ignoredUserMessageIds?.size).toBe(32);
    expect(internal.ignoredUserMessageIds?.has('provider-0')).toBe(false);
    expect(internal.ignoredUserMessageIds?.has('provider-32')).toBe(true);
  });
});
