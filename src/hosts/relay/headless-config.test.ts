import { describe, expect, it } from 'vitest';

import { parseRelayHeadlessConfig } from './headless-config';

describe('Relay headless instance config', () => {
  it.each(['Instance-a', '实例-a', 'a'.repeat(64), '-instance', 'instance-'])(
    'rejects non-exact Linux instance %s',
    (instanceId) => {
      expect(() => parseRelayHeadlessConfig({
        schemaVersion: 1,
        instanceId,
        tickIntervalMs: 1_000,
        plumbingModule: null,
        credentials: [],
      })).toThrow('lowercase Linux instance label');
    },
  );
});
