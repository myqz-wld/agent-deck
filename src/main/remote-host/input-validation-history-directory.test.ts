import { describe, expect, it } from 'vitest';

import { parseRemoteHostSessionHistoryMutation } from './input-validation-session-history';
import { parseRemoteHostWorkspaceDirectoryCreate } from './input-validation-workspace-directory';

const authority = { authoritativeCoreId: 'core-a', workerGeneration: 3 };

describe('Remote history and Workspace mutation input validation', () => {
  it('accepts only an exact history row CAS request', () => {
    const request = {
      profileId: 'remote-a', sessionId: 'session-a', expectedArchived: false,
      expectedUpdatedAt: 7, expectedAuthority: authority, intentId: 'intent-history-a',
    };
    expect(parseRemoteHostSessionHistoryMutation(request)).toEqual(request);
    expect(() => parseRemoteHostSessionHistoryMutation({ ...request, unexpected: true }))
      .toThrow('unexpected fields');
    expect(() => parseRemoteHostSessionHistoryMutation({
      ...request, expectedUpdatedAt: -1,
    })).toThrow('invalid');
  });

  it('accepts one Workspace-relative parent and direct child name', () => {
    const request = {
      profileId: 'remote-a', parentDirectory: 'repo/subdir', name: 'new-folder',
      expectedAuthority: authority, intentId: 'intent-directory-a',
    };
    expect(parseRemoteHostWorkspaceDirectoryCreate(request)).toEqual(request);
    for (const name of ['', '.', '..', '../outside', 'nested/child', 'nested\\child']) {
      expect(() => parseRemoteHostWorkspaceDirectoryCreate({ ...request, name }))
        .toThrow('invalid');
    }
    expect(() => parseRemoteHostWorkspaceDirectoryCreate({
      ...request, parentDirectory: '../outside',
    })).toThrow('invalid');
  });
});
