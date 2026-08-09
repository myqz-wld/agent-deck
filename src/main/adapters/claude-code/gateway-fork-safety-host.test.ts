import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopClaudeGatewayForkSafetyHost as host } from './gateway-fork-safety-host';

describe('desktop Claude Gateway fork safety host', () => {
  it('owns config-root discovery and physical-path canonicalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-deck-fork-safety-host-'));
    const alias = `${directory}-alias`;
    await symlink(directory, alias);

    try {
      expect(host.getMainConfigRoot({ CLAUDE_CONFIG_DIR: directory })).toBe(directory);
      expect(host.canonicalizeConfigRoot(alias)).toBe(host.canonicalizeConfigRoot(directory));
    } finally {
      await rm(alias, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
