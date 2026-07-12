import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StreamProcessor } from '../stream-processor';

function makeProcessor(): StreamProcessor {
  return new StreamProcessor({
    sessions: new Map(),
    emit: () => undefined,
  });
}

describe('StreamProcessor.makeUserMessage', () => {
  it('marks plain user messages as priority now', async () => {
    const msg = await makeProcessor().makeUserMessage('sess-1', 'hello')();

    expect(msg).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      priority: 'now',
      session_id: 'sess-1',
    });
  });

  it('marks attachment user messages as priority now', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-deck-claude-msg-'));
    const imagePath = join(dir, 'img.png');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      const pending = makeProcessor().makeUserMessage('sess-img', 'describe', [
        { kind: 'uploaded', path: imagePath, mime: 'image/png', bytes: 4 },
      ]);
      expect(pending.handOffMessage).toEqual({
        text: 'describe',
        attachments: [{ kind: 'uploaded', path: imagePath, mime: 'image/png', bytes: 4 }],
      });
      const msg = await pending();

      expect(msg.priority).toBe('now');
      expect(msg.session_id).toBe('sess-img');
      expect(msg.message.role).toBe('user');
      expect(msg.message.content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          },
        },
        { type: 'text', text: 'describe' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
