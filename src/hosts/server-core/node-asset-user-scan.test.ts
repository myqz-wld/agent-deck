import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanServerCoreUserAssets } from './node-asset-user-scan';

describe('scanServerCoreUserAssets bounds', () => {
  it('stops nested plugin discovery at the shared traversal budget', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-deck-node-asset-budget-'));
    try {
      const plugins = join(home, '.claude', 'plugins');
      for (let index = 0; index < 20; ++index) {
        mkdirSync(join(plugins, `empty-${index}`, 'nested'), { recursive: true });
      }

      const result = scanServerCoreUserAssets(home, {
        maxAssets: 10,
        maxVisitedEntries: 5,
      });

      expect(result.assets).toEqual([]);
      expect(result.truncated).toBe(true);
      expect(result.visitedEntries).toBe(5);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
