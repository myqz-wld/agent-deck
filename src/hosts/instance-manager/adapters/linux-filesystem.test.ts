import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { LinuxDescriptorFileSystem } from './linux-filesystem';

const temporary: string[] = [];

async function tempRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'agent-deck-fs-'));
  const canonical = await realpath(created);
  temporary.push(canonical);
  return canonical;
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function adapter(): LinuxDescriptorFileSystem {
  return new LinuxDescriptorFileSystem({
    platform: process.platform,
    testOnlyDirectPaths: true,
  });
}

describe('Linux descriptor filesystem', () => {
  it('creates, atomically replaces, and removes only exact regular identities', async () => {
    const root = await tempRoot();
    const fileSystem = adapter();
    const directory = join(root, 'state');
    await fileSystem.createDirectory(directory, 0o700);
    const initial = await fileSystem.createFileExclusive(
      join(directory, 'record.json'),
      new TextEncoder().encode('one'),
      0o600,
    );
    const staged = join(directory, '.record.tmp');
    await fileSystem.createFileExclusive(staged, new TextEncoder().encode('two'), 0o600);
    const replaced = await fileSystem.replaceFileAtomic(
      staged,
      join(directory, 'record.json'),
      initial,
    );
    expect(new TextDecoder().decode(await fileSystem.readFile(
      join(directory, 'record.json'),
      16,
    ))).toBe('two');
    await expect(fileSystem.removeFileExact(
      join(directory, 'record.json'),
      initial,
    )).rejects.toMatchObject({ code: 'identity_changed' });
    await fileSystem.removeFileExact(join(directory, 'record.json'), replaced);
  });

  it('rejects symlink traversal and special entries in an exact tree', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(root, 'redirect'));
    const fileSystem = adapter();

    await expect(fileSystem.readFile(join(root, 'redirect', 'secret'), 64))
      .rejects.toMatchObject({ code: 'filesystem_failed' });
    await expect(fileSystem.captureTreeExact(root, 10))
      .rejects.toMatchObject({ code: 'filesystem_failed' });
  });

  it('revalidates a bounded same-device tree before descriptor-relative deletion', async () => {
    const root = await tempRoot();
    const fileSystem = adapter();
    const tree = join(root, 'tree');
    await fileSystem.createDirectory(tree, 0o700);
    await fileSystem.createFileExclusive(
      join(tree, 'item'),
      new TextEncoder().encode('before'),
      0o600,
    );
    const stale = await fileSystem.captureTreeExact(tree, 10);
    await writeFile(join(tree, 'item'), 'changed-and-longer');
    await expect(fileSystem.removeTreeExact(stale))
      .rejects.toMatchObject({ code: 'identity_changed' });
    const current = await fileSystem.captureTreeExact(tree, 10);
    await fileSystem.removeTreeExact(current);
    expect(await fileSystem.lstat(tree)).toBeNull();
  });
});
