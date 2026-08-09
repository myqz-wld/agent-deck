import { describe, expect, it } from 'vitest';

import { parseRemoteHostImageAssetRequest } from './input-validation-session-detail';

describe('Remote image asset IPC validation', () => {
  it('accepts only an opaque session-bound Remote file-change handle', () => {
    expect(parseRemoteHostImageAssetRequest({
      profileId: 'remote-a',
      sessionId: 'session-a',
      source: { kind: 'remote-file-change', changeId: 3, side: 'after' },
    })).toEqual({
      profileId: 'remote-a',
      sessionId: 'session-a',
      source: { kind: 'remote-file-change', changeId: 3, side: 'after' },
    });
    for (const source of [
      { kind: 'path', path: '/etc/secret.png' },
      { kind: 'remote-file-change', changeId: 0, side: 'after' },
      { kind: 'remote-file-change', changeId: 3, side: 'other' },
      { kind: 'remote-file-change', changeId: 3, side: 'after', path: '/tmp/a.png' },
    ]) {
      expect(() => parseRemoteHostImageAssetRequest({
        profileId: 'remote-a', sessionId: 'session-a', source,
      })).toThrow();
    }
  });
});
