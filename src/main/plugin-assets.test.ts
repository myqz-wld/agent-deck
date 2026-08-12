import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { discoverPluginRoots } from './plugin-assets';

describe('discoverPluginRoots manifest authority', () => {
  it('does not follow or accept a symlinked manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-plugin-manifest-'));
    try {
      const plugin = join(root, 'demo');
      const manifestDirectory = join(plugin, '.codex-plugin');
      const secret = join(root, 'auth.json');
      mkdirSync(manifestDirectory, { recursive: true });
      writeFileSync(secret, '{"token":"secret"}');
      symlinkSync(secret, join(manifestDirectory, 'plugin.json'));
      const readManifest = vi.fn(() => '{"name":"must-not-read"}');

      expect(discoverPluginRoots({
        searchPaths: [plugin],
        manifestPaths: ['.codex-plugin/plugin.json'],
        readManifest,
      })).toEqual([]);
      expect(readManifest).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
