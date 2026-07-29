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
      'Grok Build 二进制路径必须是绝对路径；留空则使用内置 CLI。',
    );
    const missing = join(dir, 'missing');
    await expect(resolveGrokBinary(missing)).rejects.toThrow(
      `在 ${missing} 找不到 Grok Build 二进制文件。`,
    );
  });
});
