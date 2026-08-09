import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopClaudeUserMessageStreamHost as host } from './user-message-stream-host';

describe('desktop Claude user message stream host', () => {
  it('owns attachment reads, provider IDs, and the wall clock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-deck-message-host-'));
    const path = join(directory, 'attachment.bin');
    await writeFile(path, Buffer.from([0x00, 0x01, 0x02, 0xff]));

    try {
      await expect(host.readAttachmentBase64(path)).resolves.toBe('AAEC/w==');
      expect(host.createProviderMessageId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(host.now()).toEqual(expect.any(Number));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
