import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_SCREENSHOT_MAX_AGE_MS,
  BROWSER_SCREENSHOT_REAP_INTERVAL_MS,
  BrowserScreenshotStore,
} from '../screenshot-store';

const roots: string[] = [];

async function makeStore(now: () => number = Date.now): Promise<{
  base: string;
  root: string;
  store: BrowserScreenshotStore;
}> {
  const base = await fsp.mkdtemp(join(tmpdir(), 'agent-deck-screenshot-store-'));
  roots.push(base);
  const root = join(base, 'agent-deck-browser');
  return {
    base,
    root,
    store: new BrowserScreenshotStore({
      rootDir: root,
      now,
      id: () => '00000000-0000-4000-8000-000000000000',
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('BrowserScreenshotStore', () => {
  it('writes a private generated PNG below a sanitized session directory', async () => {
    const { root, store } = await makeStore(() => 1_700_000_000_000);

    const path = await store.persist('../sid/with spaces', 4, Buffer.from('png'));
    const stat = await fsp.stat(path);

    expect(path.startsWith(`${root}${sep}`)).toBe(true);
    expect(path).toContain(`${sep}.._sid_with_spaces${sep}`);
    expect(path).toMatch(/tab-4-1700000000000-[0-9a-f-]+\.png$/);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    await store.maybeReap();
  });

  it('reaps only stale generated screenshots and never follows symlinks', async () => {
    const now = 1_700_000_000_000;
    const { base, root, store } = await makeStore(() => now);
    const sessionDir = join(root, 'sid-1');
    await fsp.mkdir(sessionDir, { recursive: true });

    const oldGenerated = join(sessionDir, 'tab-1-1600000000000.png');
    const oldCurrentFormat = join(
      sessionDir,
      'tab-2-1600000000000-00000000-0000-4000-8000-000000000000.png',
    );
    const freshGenerated = join(sessionDir, 'tab-1-1700000000000.png');
    const unrelated = join(sessionDir, 'notes.png');
    await Promise.all([
      fsp.writeFile(oldGenerated, 'old'),
      fsp.writeFile(oldCurrentFormat, 'old-current'),
      fsp.writeFile(freshGenerated, 'fresh'),
      fsp.writeFile(unrelated, 'unrelated'),
    ]);
    const oldDate = new Date(now - BROWSER_SCREENSHOT_MAX_AGE_MS - 1);
    await Promise.all([
      fsp.utimes(oldGenerated, oldDate, oldDate),
      fsp.utimes(oldCurrentFormat, oldDate, oldDate),
    ]);

    const outsideFile = join(base, 'outside.png');
    const outsideDir = join(base, 'outside-dir');
    await fsp.writeFile(outsideFile, 'outside');
    await fsp.mkdir(outsideDir);
    await fsp.writeFile(join(outsideDir, 'tab-2-1600000000000.png'), 'outside-dir');
    await fsp.symlink(outsideFile, join(sessionDir, 'tab-9-1600000000000.png'));
    await fsp.symlink(outsideDir, join(root, 'linked-session'));

    await expect(store.reap()).resolves.toBe(2);
    await expect(fsp.stat(oldGenerated)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(oldCurrentFormat)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.readFile(freshGenerated, 'utf8')).resolves.toBe('fresh');
    await expect(fsp.readFile(unrelated, 'utf8')).resolves.toBe('unrelated');
    await expect(fsp.readFile(outsideFile, 'utf8')).resolves.toBe('outside');
    await expect(
      fsp.readFile(join(outsideDir, 'tab-2-1600000000000.png'), 'utf8'),
    ).resolves.toBe('outside-dir');
  });

  it('shares one daily throttle across startup and opportunistic reaps', async () => {
    let now = 1_700_000_000_000;
    const { store } = await makeStore(() => now);
    const reap = vi.spyOn(store, 'reap');

    await store.reapAtStartup();
    await store.maybeReap();
    now += BROWSER_SCREENSHOT_REAP_INTERVAL_MS - 1;
    await store.maybeReap();
    expect(reap).toHaveBeenCalledTimes(1);

    now += 1;
    await store.maybeReap();
    expect(reap).toHaveBeenCalledTimes(2);
  });

  it('refuses a symlinked managed root instead of writing through it', async () => {
    const { base, root, store } = await makeStore();
    const outsideDir = join(base, 'outside');
    await fsp.mkdir(outsideDir);
    await fsp.symlink(outsideDir, root);

    await expect(store.persist('sid-1', 1, Buffer.from('png'))).rejects.toThrow(
      /not a real directory/,
    );
    await expect(store.reap()).rejects.toThrow(/not a real directory/);
    await expect(fsp.readdir(outsideDir)).resolves.toEqual([]);
  });
});
