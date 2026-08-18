import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeBrowserUseFrame } from '@main/browser-use/protocol';

import {
  decodeProviderSessionBrowserContext,
  prepareProviderSessionBrowserRuntime,
} from './browser-runtime';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Provider session Browser runtime context', () => {
  it('accepts only the browser-scoped proof and contains no selectable session identity', () => {
    const value = {
      protocolVersion: 1,
      adapterId: 'grok-build',
      lease: 'abcdefghijklmnopqrstuvwxyz012345',
      runtimeGeneration: 1,
      sourceIdentity: 'runtime-source-a',
    };

    expect(decodeProviderSessionBrowserContext(encoded(value))).toEqual(value);
    expect(JSON.stringify(value)).not.toContain('sessionId');
    expect(() => decodeProviderSessionBrowserContext(encoded({
      ...value, sessionId: 'session-b',
    }))).toThrow('invalid');
    expect(() => decodeProviderSessionBrowserContext(encoded({
      ...value, adapterId: 'codex-cli',
    }))).toThrow('invalid');
  });

  it('rejects malformed or oversized encoded contexts before filesystem mutation', () => {
    expect(() => decodeProviderSessionBrowserContext('***')).toThrow('invalid');
    expect(() => decodeProviderSessionBrowserContext('a'.repeat(4_097))).toThrow('invalid');
  });

  it('materializes a private shim and relays one opaque frame through the local proxy', async () => {
    const root = await realpath(await mkdtemp(join(await realpath('/tmp'), 'adpb-')));
    roots.push(root);
    const bin = join(root, 'bin');
    const node = join(root, 'node');
    const cli = join(root, 'agent-deck-browser.cjs');
    await mkdir(bin, { mode: 0o700 });
    await writeFile(node, '#!/bin/sh\n', { mode: 0o700 });
    await writeFile(cli, '#!/bin/sh\n', { mode: 0o700 });
    await chmod(node, 0o700);
    await chmod(cli, 0o700);
    const paths = {
      root,
      bin,
      context: join(root, 'context.json'),
      proxy: join(root, 'proxy.sock'),
      direct: join(root, 'direct.sock'),
      command: join(bin, 'agent-deck-browser'),
      node,
      cli,
    };
    const context = {
      protocolVersion: 1,
      adapterId: 'grok-build',
      lease: 'abcdefghijklmnopqrstuvwxyz012345',
      runtimeGeneration: 1,
      sourceIdentity: 'runtime-source-a',
    };
    const response = encodeBrowserUseFrame({ ok: true, tabs: [] }, 1024);
    const requestBrowser = vi.fn(async () => response);
    const handle = await prepareProviderSessionBrowserRuntime({
      encodedContext: encoded(context),
      executableOwner: process.getuid?.() ?? 0,
      multiplex: { requestBrowser },
      paths,
      transport: 'stdio-multiplex-v1',
    });

    expect(handle?.environment.PATH?.split(':')[0]).toBe(bin);
    expect(JSON.parse(await readFile(paths.context, 'utf8'))).toEqual({
      ...context, endpoint: paths.proxy,
    });
    expect((await lstat(paths.context)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.command, 'utf8')).not.toContain('session-a');

    const request = encodeBrowserUseFrame({ request: { operation: 'tabs' } }, 1024);
    const received = await new Promise<Buffer>((resolve, reject) => {
      const socket = createConnection(paths.proxy);
      const chunks: Buffer[] = [];
      socket.once('connect', () => socket.write(request));
      socket.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      socket.once('end', () => resolve(Buffer.concat(chunks)));
      socket.once('error', reject);
    });
    expect(received).toEqual(response);
    expect(requestBrowser).toHaveBeenCalledWith(request);
    await handle?.close();
    await expect(lstat(paths.proxy)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
