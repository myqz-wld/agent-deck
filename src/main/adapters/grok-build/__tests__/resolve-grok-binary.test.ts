import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const [{ realpathSync }, { tmpdir: getTmpdir }, { join: joinPath }] = await Promise.all([
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  return {
    app: {
      getPath: () => joinPath(realpathSync(getTmpdir()), 'agent-deck-grok-test-userData'),
    },
  };
});

import {
  materializeCompressedGrokBinary,
  resolveGrokBinary,
  type GrokBinaryMaterializationOptions,
} from '../resolve-grok-binary';

const cleanupRoots: string[] = [];
const originalCacheOverride = process.env.AGENT_DECK_GROK_CACHE_DIR;

afterEach(async () => {
  if (originalCacheOverride === undefined) delete process.env.AGENT_DECK_GROK_CACHE_DIR;
  else process.env.AGENT_DECK_GROK_CACHE_DIR = originalCacheOverride;
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('resolveGrokBinary', () => {
  it('uses the bundled native binary when no override is configured', async () => {
    delete process.env.AGENT_DECK_GROK_CACHE_DIR;
    const bundled = await resolveGrokBinary(null);
    const blankOverride = await resolveGrokBinary('   ');

    expect(bundled).not.toBe('grok');
    expect(blankOverride).toBe(bundled);
    expect(bundled).toContain(join('agent-deck-grok-test-userData', 'grok-binary-cache'));
    await expect(access(bundled)).resolves.toBeUndefined();
  });

  it('retains the explicit cache-root override', async () => {
    const root = await tempRoot();
    const cache = join(root, 'override-cache');
    process.env.AGENT_DECK_GROK_CACHE_DIR = cache;

    await expect(resolveGrokBinary(null)).resolves.toMatch(
      new RegExp(`^${escapeRegExp(cache)}`),
    );
  });

  it('accepts an existing absolute override and rejects invalid paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-deck-grok-binary-'));
    cleanupRoots.push(dir);
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

describe('materializeCompressedGrokBinary', () => {
  it('replaces a precreated unsafe attacker file even when its bytes match', async () => {
    const fixture = await materializationFixture();
    await mkdir(fixture.versionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(fixture.destination, fixture.payload, { mode: 0o700 });
    const before = await lstat(fixture.destination);
    if (process.platform !== 'win32') await chmod(fixture.destination, 0o722);

    await expect(materializeCompressedGrokBinary(fixture.options))
      .resolves.toBe(fixture.destination);

    const after = await lstat(fixture.destination);
    expect(after.isSymbolicLink()).toBe(false);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o022).toBe(0);
    expect(await readFile(fixture.destination)).toEqual(fixture.payload);
  });

  it('atomically replaces a destination symlink without changing its target', async () => {
    const fixture = await materializationFixture();
    await mkdir(fixture.versionDirectory, { recursive: true, mode: 0o700 });
    const attackerTarget = join(fixture.root, 'attacker-owned');
    await writeFile(attackerTarget, 'leave me alone');
    await symlink(attackerTarget, fixture.destination);

    await materializeCompressedGrokBinary(fixture.options);

    expect((await lstat(fixture.destination)).isSymbolicLink()).toBe(false);
    expect(await readFile(fixture.destination)).toEqual(fixture.payload);
    expect(await readFile(attackerTarget, 'utf8')).toBe('leave me alone');
  });

  it.skipIf(process.platform === 'win32')('fails closed on a writable cache ancestor', async () => {
    const fixture = await materializationFixture();
    await mkdir(fixture.versionDirectory, { recursive: true, mode: 0o700 });
    await chmod(fixture.versionDirectory, 0o777);

    await expect(materializeCompressedGrokBinary(fixture.options)).rejects.toThrow(
      '缓存目录允许组或其他用户写入',
    );
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked cache ancestor', async () => {
    const fixture = await materializationFixture();
    await mkdir(fixture.options.cacheRoot, { mode: 0o700 });
    const redirected = join(fixture.root, 'redirected-cache');
    await mkdir(redirected, { mode: 0o700 });
    await symlink(redirected, fixture.versionDirectory);

    await expect(materializeCompressedGrokBinary(fixture.options)).rejects.toThrow(
      '缓存目录不安全',
    );
    await expect(access(join(redirected, 'grok'))).rejects.toThrow();
  });

  it('keeps Windows materialization independent of POSIX uid and mode bits', async () => {
    const fixture = await materializationFixture();
    await mkdir(fixture.versionDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(fixture.versionDirectory, 0o777);

    await expect(materializeCompressedGrokBinary({
      ...fixture.options,
      platform: 'win32',
      uid: 99_999,
    })).resolves.toBe(fixture.destination);
    expect(await readFile(fixture.destination)).toEqual(fixture.payload);
  });

  it('replaces a secure but mismatched destination', async () => {
    const fixture = await materializationFixture();
    await mkdir(fixture.versionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(fixture.destination, 'mismatched executable', { mode: 0o700 });

    await materializeCompressedGrokBinary(fixture.options);

    expect(await readFile(fixture.destination)).toEqual(fixture.payload);
  });

  it('publishes the same verified file under concurrent materialization', async () => {
    const fixture = await materializationFixture();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => materializeCompressedGrokBinary(fixture.options)),
    );

    expect(new Set(results)).toEqual(new Set([fixture.destination]));
    expect(await readFile(fixture.destination)).toEqual(fixture.payload);
    expect(await readdir(fixture.versionDirectory)).toEqual(['grok']);
  });

  it('reuses a valid cached artifact without rewriting it', async () => {
    const fixture = await materializationFixture();
    await materializeCompressedGrokBinary(fixture.options);
    const oldTime = new Date('2020-01-02T03:04:05.000Z');
    await utimes(fixture.destination, oldTime, oldTime);
    const before = await stat(fixture.destination);

    await expect(materializeCompressedGrokBinary(fixture.options))
      .resolves.toBe(fixture.destination);

    const after = await stat(fixture.destination);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-deck-grok-materialize-')));
  cleanupRoots.push(root);
  return root;
}

async function materializationFixture(): Promise<{
  root: string;
  payload: Buffer;
  versionDirectory: string;
  destination: string;
  options: GrokBinaryMaterializationOptions;
}> {
  const root = await tempRoot();
  const payload = Buffer.from('#!/bin/sh\nprintf secure-grok\\n', 'utf8');
  const compressedPath = join(root, 'grok.br');
  const cacheRoot = join(root, 'cache');
  const cacheKey = 'test-version-darwin-arm64';
  const versionDirectory = join(cacheRoot, cacheKey);
  const destination = join(versionDirectory, 'grok');
  await writeFile(compressedPath, brotliCompressSync(payload));
  return {
    root,
    payload,
    versionDirectory,
    destination,
    options: { compressedPath, cacheRoot, cacheKey, binaryName: 'grok' },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
