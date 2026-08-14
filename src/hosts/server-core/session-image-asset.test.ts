import {
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_IMAGE_ASSET_CHUNK_BYTES } from '@contracts/index';
import type { FileChangePayload, FileChangeSummary } from '@shared/types';
import {
  fileChangePathAuthorityFromMetadata,
  withStoredFileChangePathAuthority,
} from '@shared/file-change-path-authority';
import {
  ServerCoreSessionImageAssetReader,
  type SessionImageAssetFilesystem,
} from './session-image-asset';

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
    metadata: withStoredFileChangePathAuthority({}, realpathSync(image)),
    toolCallId: null,
    ts: 1,
  };
  let descriptor = toDescriptor(change);
  const getPayload = vi.fn(
    (sessionId: string, id: number) => sessionId === 'session-a' && id === 3 ? change : null,
  );
  const reader = new ServerCoreSessionImageAssetReader(workspace, { getPayload });
  return {
    descriptor: () => descriptor,
    getPayload,
    outside,
    reader,
    workspace,
    setPayload: (next: FileChangePayload) => { change = next; },
    setChange: (next: FileChangePayload) => {
      change = next;
      descriptor = toDescriptor(next);
    },
  };
}

function toDescriptor(change: FileChangePayload): FileChangeSummary {
  return {
    id: change.id,
    sessionId: change.sessionId,
    filePath: change.filePath,
    kind: change.kind,
    toolCallId: change.toolCallId,
    hasBeforeBlob: change.beforeBlob !== null,
    hasAfterBlob: change.afterBlob !== null,
    hasBeforeSnapshot: change.beforeSnapshot != null,
    hasAfterSnapshot: change.afterSnapshot != null,
    pathAuthority: fileChangePathAuthorityFromMetadata(change.metadata),
    ts: change.ts,
  };
}

describe('ServerCoreSessionImageAssetReader', () => {
  it('reads an authoritative Workspace image in identity-fenced chunks', async () => {
    const { descriptor, reader } = fixture();
    const signal = new AbortController().signal;
    const first = await reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, signal, descriptor());
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
    }, signal, descriptor());
    expect(second).toMatchObject({ ok: true, bytes: 7, nextOffset: null });
    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after',
      offset: first.nextOffset!, expectedAssetId: 'A'.repeat(43),
    }, signal, descriptor())).resolves.toEqual({ ok: false, reason: 'changed' });
  });

  it('never exposes or follows an image source outside Workspace', async () => {
    const { descriptor, getPayload, outside, reader, setChange } = fixture();
    const secret = join(outside, 'secret.png');
    writeFileSync(secret, 'secret');
    const link = join(roots.at(-1)!, 'Workspace', 'link.png');
    symlinkSync(secret, link);
    setChange({
      id: 3, sessionId: 'session-a', filePath: link, kind: 'image', beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: link }),
      metadata: withStoredFileChangePathAuthority({}, realpathSync(link)),
      toolCallId: null, ts: 1,
    });
    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, new AbortController().signal, descriptor())).resolves.toEqual({ ok: false, reason: 'denied' });
    expect(getPayload).not.toHaveBeenCalled();
    const change = {
      id: 3, sessionId: 'session-a', filePath: secret, kind: 'image', beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: secret }),
      metadata: withStoredFileChangePathAuthority({}, realpathSync(secret)),
      toolCallId: null, ts: 1,
    };
    expect(reader.publicHandle(toDescriptor(change), change, 'after')).toBeNull();
  });

  it('denies image content recorded for provider configuration paths', async () => {
    const { descriptor, getPayload, reader, setChange } = fixture();
    const root = roots.at(-1)!;
    const providerDirectory = join(root, 'Workspace', '.claude');
    mkdirSync(providerDirectory);
    const image = join(providerDirectory, 'settings.png');
    writeFileSync(image, 'not-public');
    const change: FileChangePayload = {
      id: 3,
      sessionId: 'session-a',
      filePath: image,
      kind: 'image',
      beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: image }),
      metadata: withStoredFileChangePathAuthority({}, realpathSync(image)),
      toolCallId: null,
      ts: 1,
    };
    setChange(change);
    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, new AbortController().signal, descriptor())).resolves.toEqual({ ok: false, reason: 'denied' });
    expect(getPayload).not.toHaveBeenCalled();
    expect(reader.publicHandle(descriptor(), change, 'after')).toBeNull();
  });

  it('rejects descriptor and payload drift before reading an image source', async () => {
    const { descriptor, reader, setChange } = fixture();
    const authorized = descriptor();
    setChange({
      id: 3,
      sessionId: 'session-a',
      filePath: authorized.filePath,
      kind: 'image',
      beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: authorized.filePath }),
      metadata: withStoredFileChangePathAuthority({}, authorized.pathAuthority ?? null),
      toolCallId: 'replacement',
      ts: authorized.ts + 1,
    });

    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, new AbortController().signal, authorized)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_source',
    });
  });

  it('rejects a payload whose stored canonical authority changed after descriptor lookup', async () => {
    const { descriptor, reader, setPayload } = fixture();
    const authorized = {
      ...descriptor(),
      pathAuthority: descriptor().filePath,
    };
    setPayload({
      id: authorized.id,
      sessionId: authorized.sessionId,
      filePath: authorized.filePath,
      kind: authorized.kind,
      beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: authorized.filePath }),
      metadata: withStoredFileChangePathAuthority({}, '/workspaces/replacement.png'),
      toolCallId: authorized.toolCallId,
      ts: authorized.ts,
    });

    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, new AbortController().signal, authorized)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_source',
    });
  });

  it('authorizes the stored image source after the safe descriptor lookup', async () => {
    const { descriptor, getPayload, outside, reader, setPayload } = fixture();
    const safeDescriptor = descriptor();
    const secret = join(outside, 'secret.png');
    writeFileSync(secret, 'secret');
    const link = join(roots.at(-1)!, 'Workspace', 'payload-link.png');
    symlinkSync(secret, link);
    const payload: FileChangePayload = {
      id: safeDescriptor.id,
      sessionId: safeDescriptor.sessionId,
      filePath: safeDescriptor.filePath,
      kind: safeDescriptor.kind,
      beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: link }),
      metadata: withStoredFileChangePathAuthority({}, safeDescriptor.pathAuthority ?? null),
      toolCallId: safeDescriptor.toolCallId,
      ts: safeDescriptor.ts,
    };
    setPayload(payload);

    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, new AbortController().signal, safeDescriptor)).resolves.toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(getPayload).toHaveBeenCalledOnce();
    expect(reader.publicHandle(safeDescriptor, payload, 'after')).toBeNull();
  });

  it('rejects an intermediate-directory swap between authorization and open', async () => {
    const { descriptor, getPayload, outside, setChange, workspace } = fixture();
    const slot = join(workspace, 'slot');
    const originalSlot = join(workspace, 'slot-original');
    const image = join(slot, 'image.png');
    mkdirSync(slot);
    writeFileSync(image, 'public');
    writeFileSync(join(outside, 'image.png'), 'secret');
    setChange({
      id: 3,
      sessionId: 'session-a',
      filePath: image,
      kind: 'image',
      beforeBlob: null,
      afterBlob: JSON.stringify({ kind: 'path', path: image }),
      metadata: withStoredFileChangePathAuthority({}, realpathSync(image)),
      toolCallId: null,
      ts: 1,
    });
    let swapped = false;
    const racingFilesystem: SessionImageAssetFilesystem = {
      open: async (path, flags) => {
        if (!swapped) {
          swapped = true;
          renameSync(slot, originalSlot);
          symlinkSync(outside, slot, 'dir');
        }
        return open(path, flags);
      },
      realpath,
      stat: (path) => stat(path, { bigint: true }),
    };
    const reader = new ServerCoreSessionImageAssetReader(
      workspace,
      { getPayload },
      realpathSync,
      racingFilesystem,
    );

    await expect(reader.read({
      sessionId: 'session-a', changeId: 3, side: 'after', offset: 0,
    }, new AbortController().signal, descriptor())).resolves.toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(swapped).toBe(true);
    await expect(open(image, constants.O_RDONLY | constants.O_NOFOLLOW).then(async (handle) => {
      try { return (await handle.readFile()).toString('utf8'); } finally { await handle.close(); }
    })).resolves.toBe('secret');
  });
});
