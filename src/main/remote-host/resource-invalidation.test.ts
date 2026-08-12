import { describe, expect, it } from 'vitest';

import { REMOTE_HOST_RESOURCE_KINDS } from '@shared/remote-host';
import { remoteHostResourcesForCoreEvent } from './resource-invalidation';

describe('Remote host resource invalidation', () => {
  it.each([
    ['usage.tokens.changed', ['usage']],
    ['issue.updated', ['issues']],
    ['node.hook.updated', ['node-configuration']],
    ['pending.responded', ['pending', 'session-detail', 'teams']],
    ['plan.review.feedback', ['pending', 'session-detail', 'teams']],
    ['task.updated', ['session-detail', 'teams']],
    ['message.updated', ['session-detail', 'teams']],
    ['session.updated', ['session-list', 'session-detail', 'pending', 'teams']],
    ['event.persisted', ['session-list', 'session-detail', 'teams']],
    ['team.member-added', ['session-list', 'session-detail', 'teams']],
  ] as const)('maps %s to bounded resource lanes', (kind, expected) => {
    expect(remoteHostResourcesForCoreEvent(kind)).toEqual(expected);
  });

  it('invalidates every allowlisted lane for an unknown future event', () => {
    expect(remoteHostResourcesForCoreEvent('future.changed'))
      .toEqual(REMOTE_HOST_RESOURCE_KINDS);
  });
});
