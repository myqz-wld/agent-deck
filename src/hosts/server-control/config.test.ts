import { describe, expect, it } from 'vitest';

import { parseServerControlConfig } from './config';

function config(topology: 'relay' | 'full') {
  return {
    schemaVersion: 1,
    instanceId: 'instance-a',
    topology,
    authorityFile: '/var/lib/agent-deck/authority.json',
    authorizedKeysFile: '/var/lib/agent-deck/authorized_keys',
    endpoint: {
      hostname: `${topology}.example.test`,
      port: 22,
      username: 'agentdeck',
      hostKeyFile: '/etc/ssh/ssh_host_ed25519_key.pub',
    },
    relayRuntimeUid: topology === 'relay' ? 1001 : null,
    feishuIdentityOwner: { uid: 1002, gid: 1002 },
  };
}

describe('Server control config', () => {
  it.each(['relay', 'full'] as const)('accepts one exact %s config', (topology) => {
    expect(parseServerControlConfig(config(topology))).toEqual(config(topology));
  });

  it.each([
    null,
    { ...config('relay'), schemaVersion: 2 },
    { ...config('relay'), topology: 'standalone' },
    { ...config('relay'), relayRuntimeUid: null },
    { ...config('full'), relayRuntimeUid: 1001 },
    { ...config('full'), extra: true },
    { ...config('full'), feishuIdentityOwner: { uid: -1, gid: 1002 } },
  ])('rejects an invalid or mismatched config %#', (value) => {
    expect(() => parseServerControlConfig(value)).toThrow();
  });
});
