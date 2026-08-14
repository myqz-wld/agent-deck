import { describe, expect, it } from 'vitest';

import { parseServerCoreConfig } from './config';

function config(instanceId: string) {
  return {
    schemaVersion: 1,
    instanceId,
    appVersion: '1.0.0',
    runtimeModule: '/opt/agent-deck/runtime/server-core.mjs',
    runtimeOptions: {},
    socketPath: `/run/agent-deck/${instanceId}/agent-deckd.sock`,
  };
}

describe('Server Core instance config', () => {
  it('preserves current runtime options for strict downstream validation', () => {
    const parsed = parseServerCoreConfig({
      ...config('instance-a'),
      runtimeOptions: {
        providerContainer: { schemaVersion: 1 },
        projects: [],
      },
    });

    expect(parsed.runtimeOptions).toEqual({
      providerContainer: { schemaVersion: 1 },
      projects: [],
    });
  });

  it.each(['Instance-a', '实例-a', 'a'.repeat(64), '-instance', 'instance-'])(
    'rejects non-exact Linux instance %s',
    (instanceId) => {
      expect(() => parseServerCoreConfig(config(instanceId))).toThrow(
        'lowercase Linux instance label',
      );
    },
  );
});
