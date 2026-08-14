import { describe, expect, it } from 'vitest';

import { parseRelayHeadlessConfig } from './headless-config';

describe('Relay headless instance config', () => {
  it.each(['Instance-a', '实例-a', 'a'.repeat(64), '-instance', 'instance-'])(
    'rejects non-exact Linux instance %s',
    (instanceId) => {
      expect(() => parseRelayHeadlessConfig({
        schemaVersion: 2,
        instanceId,
        tickIntervalMs: 1_000,
        plumbingModule: null,
        authorityFile: `/etc/agent-deck-relay/${instanceId}/authority.json`,
      })).toThrow('lowercase Linux instance label');
    },
  );

  it('requires the exact separate per-instance authority path', () => {
    expect(() => parseRelayHeadlessConfig({
      schemaVersion: 2,
      instanceId: 'instance-a',
      tickIntervalMs: 1_000,
      plumbingModule: null,
      authorityFile: '/etc/agent-deck-relay/instance-b/authority.json',
    })).toThrow('exact per-instance container path');
  });

  it('rejects embedding mutable credentials in the immutable runtime config', () => {
    expect(() => parseRelayHeadlessConfig({
      schemaVersion: 2,
      instanceId: 'instance-a',
      tickIntervalMs: 1_000,
      plumbingModule: null,
      authorityFile: '/etc/agent-deck-relay/instance-a/authority.json',
      credentials: [],
    })).toThrow('missing or extra fields');
  });
});
