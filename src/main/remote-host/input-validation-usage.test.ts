import { describe, expect, it } from 'vitest';

import {
  parseRemoteHostUsageProvider,
  parseRemoteHostUsageToken,
} from './input-validation-usage';

describe('Remote usage IPC input validation', () => {
  it('accepts only exact bounded usage reads', () => {
    expect(parseRemoteHostUsageToken({
      profileId: 'remote-a', includeDaily: true, dailyLimit: 500,
    })).toEqual({ profileId: 'remote-a', includeDaily: true, dailyLimit: 500 });
    expect(parseRemoteHostUsageProvider({ profileId: 'remote-a', force: true }))
      .toEqual({ profileId: 'remote-a', force: true });
    expect(() => parseRemoteHostUsageToken({
      profileId: 'remote-a', includeDaily: true, dailyLimit: 0,
    })).toThrow('invalid token usage request');
    expect(() => parseRemoteHostUsageProvider({
      profileId: 'remote-a', force: false, provider: 'codex-cli',
    })).toThrow('unexpected fields');
  });
});
