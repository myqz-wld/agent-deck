import { describe, expect, it } from 'vitest';

import {
  remoteHistoryRequest,
  remotePageRequest,
} from '@shared/remote-host';
import {
  parseRemoteHostHistoryRequest,
  parseRemoteHostPageRequest,
} from './input-validation';

describe('remote renderer to main request contract', () => {
  it('omits absent cursors across structured clone and the exact main parser', () => {
    const projects = structuredClone(remotePageRequest('profile-a', 40));
    const history = structuredClone(remoteHistoryRequest('profile-a', 'session-a', 40));

    expect(Object.hasOwn(projects, 'cursor')).toBe(false);
    expect(Object.hasOwn(history, 'cursor')).toBe(false);
    expect(parseRemoteHostPageRequest(projects)).toEqual(projects);
    expect(parseRemoteHostHistoryRequest(history)).toEqual(history);
  });

  it('retains explicit cursors for paginated calls', () => {
    expect(parseRemoteHostPageRequest(remotePageRequest('profile-a', 40, 'project-next')))
      .toMatchObject({ cursor: 'project-next' });
    expect(parseRemoteHostHistoryRequest(remoteHistoryRequest(
      'profile-a',
      'session-a',
      40,
      'history-next',
    ))).toMatchObject({ cursor: 'history-next' });
  });
});
