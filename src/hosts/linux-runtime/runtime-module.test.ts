import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  createTrustedRuntimeModuleLoader,
  type TrustedRuntimeModulePorts,
} from './runtime-module';

function trustedStat() {
  return {
    dev: 1,
    ino: 2,
    mode: 0o100444,
    uid: 1001,
    size: 42,
    mtimeMs: 7,
    isFile: () => true,
  };
}

describe('trusted runtime module loader', () => {
  it('fails unsupported production semantics before opening or pathname-importing', async () => {
    const open = vi.fn();
    const importModule = vi.fn();
    const loader = createTrustedRuntimeModuleLoader({
      platform: 'win32',
      currentUid: () => 1001,
      realpath: vi.fn(async (path: string) => path),
      lstat: vi.fn(),
      open,
      importModule,
    } as unknown as TrustedRuntimeModulePorts);

    await expect(loader('/opt/agent-deck/runtime.mjs')).rejects.toThrow(
      'require Linux or macOS descriptor imports',
    );
    expect(open).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('imports only the verified Linux descriptor and rechecks pathname identity', async () => {
    const stat = trustedStat();
    const handle = {
      fd: 17,
      stat: vi.fn(async () => ({ ...stat })),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const importModule = vi.fn(async () => ({ createRuntime: () => undefined }));
    const realpath = vi.fn(async (path: string) => path);
    const loader = createTrustedRuntimeModuleLoader({
      platform: 'linux',
      currentUid: () => 1001,
      realpath,
      lstat: vi.fn(async () => ({ ...stat })),
      open: vi.fn(async () => handle),
      importModule,
    } as unknown as TrustedRuntimeModulePorts);

    await expect(loader('/opt/agent-deck/runtime.mjs')).resolves.toHaveProperty('createRuntime');
    expect(importModule).toHaveBeenCalledWith('file:///proc/self/fd/17');
    expect(importModule).not.toHaveBeenCalledWith('file:///opt/agent-deck/runtime.mjs');
    expect(realpath).toHaveBeenCalledTimes(2);
    expect(handle.stat).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('uses the verified macOS descriptor without a pathname fallback', async () => {
    const stat = trustedStat();
    const handle = {
      fd: 19,
      stat: vi.fn(async () => ({ ...stat })),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const importModule = vi.fn(async () => ({ createRuntime: () => undefined }));
    const loader = createTrustedRuntimeModuleLoader({
      platform: 'darwin',
      currentUid: () => 1001,
      realpath: vi.fn(async (path: string) => path),
      lstat: vi.fn(async () => ({ ...stat })),
      darwinDependencyUrl: () =>
        'file:///Applications/Agent%20Deck.app/Contents/Resources/app.asar/node_modules/' +
        'better-sqlite3/lib/index.js',
      open: vi.fn(async () => handle),
      importModule,
    } as unknown as TrustedRuntimeModulePorts);

    const runtime =
      '/Applications/Agent Deck.app/Contents/Resources/linux-headless/local-worker-runtime/index.mjs';
    await expect(loader(runtime))
      .resolves.toHaveProperty('createRuntime');
    expect(importModule).toHaveBeenCalledWith(
      'file:///dev/fd/19',
      'file:///Applications/Agent%20Deck.app/Contents/Resources/app.asar/node_modules/' +
        'better-sqlite3/lib/index.js',
    );
    expect(importModule).not.toHaveBeenCalledWith(
      'file:///Applications/Agent%20Deck.app/Contents/Resources/linux-headless/' +
        'local-worker-runtime/index.mjs',
    );
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
