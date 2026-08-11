import { describe, expect, it } from 'vitest';

import { parseSessionContextGetResult } from './session-context';

describe('session context contract', () => {
  it('accepts a runtime-bound context snapshot and an explicit absent snapshot', () => {
    const value = {
      contextUsage: {
        usedTokens: 12_345,
        windowTokens: 1_000_000,
        updatedAt: 42,
        runtimeIdentity: {
          version: 1,
          runtimeKey: 'claude-code:deepseek:model',
          adapter: 'claude-code',
          runtimeProvider: 'deepseek',
          model: 'deepseek-v4-flash[1m]',
          capacityConfigFingerprint: 'config-a',
        },
      },
      revision: 7,
    };
    expect(parseSessionContextGetResult(value)).toEqual(value);
    expect(parseSessionContextGetResult({ contextUsage: null, revision: 8 }))
      .toEqual({ contextUsage: null, revision: 8 });
  });

  it('rejects widened or invalid context snapshots', () => {
    expect(() => parseSessionContextGetResult({
      contextUsage: null, revision: 1, localPath: '/private',
    })).toThrow('keys');
    expect(() => parseSessionContextGetResult({
      contextUsage: {
        usedTokens: 2,
        windowTokens: 0,
        updatedAt: 1,
        runtimeIdentity: null,
      },
      revision: 1,
    })).toThrow('windowTokens');
  });
});
