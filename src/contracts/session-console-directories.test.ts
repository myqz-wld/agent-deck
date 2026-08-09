import { describe, expect, it } from 'vitest';

import {
  parseWorkspaceDirectoryListParams,
  parseWorkspaceDirectoryListResult,
} from './session-console-directories';

describe('Workspace directory list contract', () => {
  it('accepts exact Workspace-relative requests and sorted direct children', () => {
    expect(parseWorkspaceDirectoryListParams({ directory: '.' })).toEqual({ directory: '.' });
    expect(parseWorkspaceDirectoryListResult({
      directory: 'repo',
      directories: [
        { directory: 'repo/alpha', name: 'alpha' },
        { directory: 'repo/zeta', name: 'zeta' },
      ],
      truncated: false,
      revision: 3,
    }, 'repo')).toEqual({
      directory: 'repo',
      directories: [
        { directory: 'repo/alpha', name: 'alpha' },
        { directory: 'repo/zeta', name: 'zeta' },
      ],
      truncated: false,
      revision: 3,
    });
  });

  it('rejects absolute, escaping, mismatched, unsorted, and extra-field projections', () => {
    for (const directory of ['/private', '../outside', 'repo/../outside', 'repo\\child']) {
      expect(() => parseWorkspaceDirectoryListParams({ directory })).toThrow();
    }
    const base = {
      directory: '.',
      directories: [{ directory: 'alpha', name: 'alpha' }],
      truncated: false,
      revision: 1,
    };
    expect(() => parseWorkspaceDirectoryListResult({
      ...base,
      directories: [{ directory: 'nested/alpha', name: 'alpha' }],
    })).toThrow();
    expect(() => parseWorkspaceDirectoryListResult({
      ...base,
      directories: [
        { directory: 'zeta', name: 'zeta' },
        { directory: 'alpha', name: 'alpha' },
      ],
    })).toThrow();
    expect(() => parseWorkspaceDirectoryListResult({ ...base, absolutePath: '/secret' }))
      .toThrow();
  });
});
