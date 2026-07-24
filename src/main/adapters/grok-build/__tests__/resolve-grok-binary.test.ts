import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveGrokBinary } from '../resolve-grok-binary';

describe('resolveGrokBinary', () => {
  it('uses the bundled native binary when no override is configured', async () => {
    const bundled = await resolveGrokBinary(null);
    const blankOverride = await resolveGrokBinary('   ');

    expect(bundled).not.toBe('grok');
    expect(blankOverride).toBe(bundled);
    await expect(access(bundled)).resolves.toBeUndefined();
  });

  it('accepts an existing absolute override and rejects invalid paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-deck-grok-binary-'));
    const binary = join(dir, 'grok');
    await writeFile(binary, '');
    await expect(resolveGrokBinary(binary)).resolves.toBe(binary);
    await expect(resolveGrokBinary('relative/grok')).rejects.toThrow(
      'must be absolute',
    );
    await expect(resolveGrokBinary(join(dir, 'missing'))).rejects.toThrow(
      'was not found',
    );
  });
});
