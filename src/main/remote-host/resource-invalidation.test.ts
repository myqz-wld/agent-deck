import { describe, expect, it } from 'vitest';

import { REMOTE_HOST_RESOURCE_KINDS } from '@shared/remote-host';
import { remoteHostResourcesForCoreEvent } from './resource-invalidation';

describe('Remote host resource invalidation', () => {
  it.each([
    ['usage.tokens.changed', ['usage']],
    ['issue.updated', ['issues']],
    ['node.hook.updated', ['node-configuration']],
    ['pending.responded', ['pending', 'session-detail']],
    ['plan.review.feedback', ['pending', 'session-detail']],
    ['task.updated', ['session-detail']],
    ['message.updated', ['session-detail']],
    ['summary.added', ['session-list', 'session-detail']],
    ['session.updated', ['session-list', 'session-detail', 'pending']],
    ['event.persisted', ['session-list', 'session-detail']],
    ['team.member-added', ['session-list', 'session-detail']],
  ] as const)('maps %s to bounded resource lanes', (kind, expected) => {
    expect(remoteHostResourcesForCoreEvent(kind)).toEqual(expected);
  });

  it('invalidates every allowlisted lane for an unknown future event', () => {
    expect(remoteHostResourcesForCoreEvent('future.changed'))
      .toEqual(REMOTE_HOST_RESOURCE_KINDS);
  });
});
