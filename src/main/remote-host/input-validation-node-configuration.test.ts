import { describe, expect, it } from 'vitest';

import {
  parseRemoteHostNodeConfiguration,
  parseRemoteHostNodeHook,
  parseRemoteHostNodeHookMutation,
} from './input-validation-node-configuration';

const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 3,
};

describe('remote node configuration input validation', () => {
  it('parses exact profile, adapter, and mutation inputs', () => {
    expect(parseRemoteHostNodeConfiguration({ profileId: 'remote-a' }))
      .toEqual({ profileId: 'remote-a' });
    expect(parseRemoteHostNodeHook({ profileId: 'remote-a', adapterId: 'codex-cli' }))
      .toEqual({ profileId: 'remote-a', adapterId: 'codex-cli' });
    expect(parseRemoteHostNodeHookMutation({
      profileId: 'remote-a', adapterId: 'grok-build', expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'hook-intent-a',
    })).toMatchObject({ intentId: 'hook-intent-a' });
  });

  it('rejects unknown adapters and extra fields', () => {
    expect(() => parseRemoteHostNodeHook({
      profileId: 'remote-a', adapterId: 'unknown',
    })).toThrow('supported provider adapter');
    expect(() => parseRemoteHostNodeConfiguration({
      profileId: 'remote-a', localFallback: true,
    })).toThrow('unexpected fields');
  });
});
