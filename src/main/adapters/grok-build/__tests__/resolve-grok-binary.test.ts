import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveGrokBinary } from '../resolve-grok-binary';

describe('resolveGrokBinary', () => {
  it('uses PATH when no override is configured', async () => {
    await expect(resolveGrokBinary(null)).resolves.toBe('grok');
    await expect(resolveGrokBinary('   ')).resolves.toBe('grok');
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
