import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';

import { buildEvidenceArchive } from './artifacts.mjs';

it('removes the local owner identity from every deployment archive header', async () => {
  const prepared = await buildEvidenceArchive({
    runtimeEgress: 'runtime egress\n', runtimeQuota: 'runtime quota\n',
    exactEgress: 'exact egress\n', exactQuota: 'exact quota\n',
  });
  try {
    const tar = gunzipSync(await readFile(prepared.archive));
    let entries = 0;
    for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
      const field = (start, size) => tar.subarray(offset + start, offset + start + size)
        .toString('utf8').replace(/\0.*$/s, '').trim();
      expect(parseInt(field(108, 8), 8)).toBe(0);
      expect(parseInt(field(116, 8), 8)).toBe(0);
      expect(['', 'root']).toContain(field(265, 32));
      expect(['', 'root']).toContain(field(297, 32));
      const size = parseInt(field(124, 12), 8) || 0;
      offset += 512 + Math.ceil(size / 512) * 512;
      entries += 1;
    }
    expect(entries).toBeGreaterThanOrEqual(5);
  } finally {
    await prepared.cleanup();
  }
});
