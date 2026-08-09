import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerCoreSessionAttachmentStore } from './session-attachment-store';

const roots: string[] = [];
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'agent-deck-remote-attachments-'));
  roots.push(value);
  return value;
}

function image(value: string) {
  const bytes = Buffer.from(value);
  return { kind: 'image' as const, base64: bytes.toString('base64'), mime: 'image/png' as const,
    bytes: bytes.byteLength };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('ServerCoreSessionAttachmentStore', () => {
  it('writes private opaque files and removes only owned references', async () => {
    const directory = join(root(), 'private-images');
    const store = new ServerCoreSessionAttachmentStore({
      rootDirectory: directory,
      createId: () => IDS[0]!,
    });
    const refs = await store.persist([image('image-bytes')]);
    expect(refs).toEqual([{
      kind: 'uploaded', path: join(realpathSync(directory), `${IDS[0]}.png`),
      mime: 'image/png', bytes: 11,
    }]);
    expect(readFileSync(refs[0]!.path, 'utf8')).toBe('image-bytes');
    expect(statSync(refs[0]!.path).mode & 0o777).toBe(0o600);
    await store.remove(refs);
    expect(() => statSync(refs[0]!.path)).toThrow();
  });

  it('rolls back siblings when a later exclusive write fails', async () => {
    const directory = join(root(), 'private-images');
    const createId = vi.fn(() => IDS[0]!);
    const store = new ServerCoreSessionAttachmentStore({ rootDirectory: directory, createId });
    await expect(store.persist([image('one'), image('two')])).rejects.toThrow();
    expect(() => statSync(join(directory, `${IDS[0]}.png`))).toThrow();
  });

  it('fails closed on unexpected files and retained-byte exhaustion', async () => {
    const directory = join(root(), 'private-images');
    const store = new ServerCoreSessionAttachmentStore({
      rootDirectory: directory,
      createId: () => IDS[1]!,
      maxRetainedBytes: 12,
    });
    writeFileSync(join(directory, 'unexpected.txt'), 'x');
    await expect(store.persist([image('one')])).rejects.toThrow('unexpected entry');
    rmSync(join(directory, 'unexpected.txt'));
    writeFileSync(join(directory, `${IDS[0]}.png`), '1234567890', { mode: 0o600 });
    await expect(store.persist([image('one')])).rejects.toThrow('quota is full');
  });

  it('rejects non-v4 attachment identifiers before creating a file', async () => {
    const directory = join(root(), 'private-images');
    const store = new ServerCoreSessionAttachmentStore({
      rootDirectory: directory,
      createId: () => '11111111-1111-1111-1111-111111111111',
    });
    await expect(store.persist([image('one')])).rejects.toThrow('id is invalid');
    expect(readdirSync(directory)).toEqual([]);
  });
});
