import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_IMAGE_ASSET_CHUNK_BYTES } from '@contracts/index';
import type { FileChangePayload } from '@shared/types';
import { ServerCoreSessionImageAssetReader } from './session-image-asset';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Test-only cleanup of the exact mkdtemp path.
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-image-asset-'));
  roots.push(root);
  const workspace = join(root, 'Workspace');
  const outside = join(root, 'private');
  mkdirSync(workspace);
  mkdirSync(outside);
  const image = join(workspace, 'large.png');
  writeFileSync(image, Buffer.alloc(SESSION_IMAGE_ASSET_CHUNK_BYTES + 7, 0x5a));
  let change: FileChangePayload = {
    id: 3,
    sessionId: 'session-a',
    filePath: image,
    kind: 'image',
    beforeBlob: null,
    afterBlob: JSON.stringify({ kind: 'path', path: image }),
    metadata: {},
    toolCallId: null,
    ts: 1,
  };
  const reader = new ServerCoreSessionImageAssetReader(workspace, {
    getPayload: (sessionId, id) => sessionId === 'session-a' && id === 3 ? change : null,
  });
  return { outside, reader, setChange: (next: FileChangePayload) => { change = next; } };
}

describe('ServerCoreSessionImageAssetReader', () => {
  it('reads an authoritative Workspace image in identity-fenced chunks', async () => {
    const { reader } = fixture();
    const signal = new AbortController().signal;
    const first = await reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, signal);
    expect(first).toMatchObject({
      ok: true,
      bytes: SESSION_IMAGE_ASSET_CHUNK_BYTES,
      mime: 'image/png',
      nextOffset: SESSION_IMAGE_ASSET_CHUNK_BYTES,
      totalBytes: SESSION_IMAGE_ASSET_CHUNK_BYTES + 7,
    });
    if (!first.ok) throw new Error('first chunk unavailable');
    expect(Buffer.from(first.base64, 'base64')).toEqual(Buffer.alloc(first.bytes, 0x5a));
    const second = await reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after',
      offset: first.nextOffset!, expectedAssetId: first.assetId,
    }, signal);
    expect(second).toMatchObject({ ok: true, bytes: 7, nextOffset: null });
    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after',
      offset: first.nextOffset!, expectedAssetId: 'A'.repeat(43),
    }, signal)).resolves.toEqual({ ok: false, reason: 'changed' });
  });

  it('never exposes or follows an image source outside Workspace', async () => {
    const { outside, reader, setChange } = fixture();
    const secret = join(outside, 'secret.png');
    writeFileSync(secret, 'secret');
    const link = join(roots.at(-1)!, 'Workspace', 'link.png');
    symlinkSync(secret, link);
    setChange({
      id: 3, sessionId: 'session-a', filePath: link, kind: 'image', beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: link }), metadata: {},
      toolCallId: null, ts: 1,
    });
    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, new AbortController().signal)).resolves.toEqual({ ok: false, reason: 'denied' });
    expect(reader.publicHandle({
      id: 3, sessionId: 'session-a', filePath: secret, kind: 'image', beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: secret }), metadata: {},
      toolCallId: null, ts: 1,
    }, 'after')).toBe(JSON.stringify({
      kind: 'remote-file-change', changeId: 3, side: 'after',
    }));
  });
});
