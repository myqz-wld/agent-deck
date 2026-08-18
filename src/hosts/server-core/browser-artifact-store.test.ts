import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ServerCoreBrowserArtifactStore } from './browser-artifact-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; cwd: string }> {
  const root = await realpath(await mkdtemp(
    join(await realpath(tmpdir()), 'agent-deck-core-browser-artifacts-'),
  ));
  roots.push(root);
  const cwd = join(root, 'repo');
  await mkdir(cwd);
  return { root, cwd };
}

describe('Server Core Browser artifact store', () => {
  it('writes a hashed session scope beneath the authoritative Workspace cwd', async () => {
    const { root, cwd } = await workspace();
    const store = new ServerCoreBrowserArtifactStore({
      workspaceRoot: root,
      getSession: () => ({ id: 'session-a', cwd }),
    });

    const path = await store.persist({
      applicationSessionId: 'session-a', tabId: 2, png: Buffer.from('png'),
    });

    expect(path).toMatch(/\/repo\/\.agent-deck\/browser-artifacts\/session-[a-f0-9]{24}\/tab-2-/);
    expect(path).not.toContain('session-a');
    expect((await lstat(path)).isFile()).toBe(true);
  });

  it('rejects a session cwd outside the Workspace before writing', async () => {
    const { root } = await workspace();
    const outside = await realpath(await mkdtemp(
      join(await realpath(tmpdir()), 'agent-deck-core-browser-outside-'),
    ));
    roots.push(outside);
    const store = new ServerCoreBrowserArtifactStore({
      workspaceRoot: root,
      getSession: () => ({ id: 'session-a', cwd: outside }),
    });

    await expect(store.persist({
      applicationSessionId: 'session-a', tabId: 1, png: Buffer.from('png'),
    })).rejects.toThrow('escapes the Workspace');
  });

  it('rejects a symlinked .agent-deck parent', async () => {
    const { root, cwd } = await workspace();
    const outside = await realpath(await mkdtemp(
      join(await realpath(tmpdir()), 'agent-deck-core-browser-link-'),
    ));
    roots.push(outside);
    await symlink(outside, join(cwd, '.agent-deck'));
    const store = new ServerCoreBrowserArtifactStore({
      workspaceRoot: root,
      getSession: () => ({ id: 'session-a', cwd }),
    });

    await expect(store.persist({
      applicationSessionId: 'session-a', tabId: 1, png: Buffer.from('png'),
    })).rejects.toThrow('unavailable');
  });
});
