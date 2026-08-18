import { chmod, lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join, normalize } from 'node:path';

import { parseProviderSessionBrowserContext } from '@contracts/index';
import { BrowserUseFrameDecoder } from '@main/browser-use/protocol';
import { BROWSER_CLI_MAX_REQUEST_BYTES } from '@main/browser-use/browser-cli-broker-protocol';

import type { ProviderSessionMultiplexConnection } from './multiplex';

const MAX_CONNECTIONS = 8;
const CONTEXT_MAX_BYTES = 4 * 1024;

export interface ProviderSessionBrowserRuntimePaths {
  readonly root: string;
  readonly bin: string;
  readonly context: string;
  readonly proxy: string;
  readonly direct: string;
  readonly command: string;
  readonly node: string;
  readonly cli: string;
}

const DEFAULT_PATHS: ProviderSessionBrowserRuntimePaths = Object.freeze({
  root: '/state/home/.agent-deck/browser',
  bin: '/state/home/.agent-deck/browser/bin',
  context: '/state/home/.agent-deck/browser/context.json',
  proxy: '/state/home/.agent-deck/browser/proxy.sock',
  direct: '/run/agent-deck/browser.sock',
  command: '/state/home/.agent-deck/browser/bin/agent-deck-browser',
  node: '/usr/local/bin/node',
  cli: '/opt/agent-deck/bin/agent-deck-browser.cjs',
});

function validatePaths(paths: ProviderSessionBrowserRuntimePaths): void {
  for (const value of Object.values(paths)) {
    if (!isAbsolute(value) || normalize(value) !== value || value === '/' || value.includes('\0')) {
      throw new Error('provider Browser runtime path is invalid');
    }
  }
  if (
    paths.bin !== join(paths.root, 'bin') ||
    paths.context !== join(paths.root, 'context.json') ||
    paths.proxy !== join(paths.root, 'proxy.sock') ||
    paths.command !== join(paths.bin, 'agent-deck-browser')
  ) throw new Error('provider Browser runtime path layout is invalid');
}

export interface ProviderSessionBrowserRuntimeHandle {
  readonly environment: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

type BrowserMultiplex = Pick<ProviderSessionMultiplexConnection, 'requestBrowser'>;

async function privateDirectory(path: string, owner: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path ||
      stat.uid !== owner || (stat.mode & 0o077) !== 0) {
    throw new Error('provider Browser runtime directory is invalid');
  }
}

async function trustedExecutable(path: string, owner: number): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path ||
      stat.uid !== owner || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) {
    throw new Error('provider Browser runtime executable is invalid');
  }
}

async function directSocket(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('provider Browser broker socket is invalid');
  }
}

export function decodeProviderSessionBrowserContext(serialized: string) {
  if (serialized.length === 0 || serialized.length > CONTEXT_MAX_BYTES ||
      !/^[A-Za-z0-9_-]+$/.test(serialized)) {
    throw new Error('provider Browser context is invalid');
  }
  let decoded: Buffer;
  try { decoded = Buffer.from(serialized, 'base64url'); } catch {
    throw new Error('provider Browser context is invalid');
  }
  if (decoded.byteLength === 0 || decoded.byteLength > CONTEXT_MAX_BYTES) {
    throw new Error('provider Browser context is invalid');
  }
  try {
    return parseProviderSessionBrowserContext(JSON.parse(decoded.toString('utf8')), 'grok-build');
  } catch {
    throw new Error('provider Browser context is invalid');
  }
}

class BrowserProxyConnection {
  private readonly decoder = new BrowserUseFrameDecoder({
    maxFrameBytes: BROWSER_CLI_MAX_REQUEST_BYTES,
    maxInputChunkBytes: BROWSER_CLI_MAX_REQUEST_BYTES + 4,
    maxMessagesPerInputChunk: 1,
    maxRetainedInputBytes: BROWSER_CLI_MAX_REQUEST_BYTES + 4,
    maxRetainedInputChunks: 128,
  });
  private readonly chunks: Buffer[] = [];
  private dispatched = false;

  constructor(
    private readonly socket: Socket,
    private readonly multiplex: BrowserMultiplex,
    private readonly closed: () => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.once('error', () => this.close());
    socket.once('close', () => this.close());
  }

  close(): void {
    this.decoder.clear();
    this.closed();
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    if (this.dispatched) {
      this.close();
      return;
    }
    try {
      this.chunks.push(Buffer.from(chunk));
      const messages = this.decoder.push(chunk);
      if (messages.length !== 1) return;
      this.dispatched = true;
      void this.multiplex.requestBrowser(Buffer.concat(this.chunks)).then(
        (response) => this.socket.end(response),
        () => this.close(),
      );
    } catch {
      this.close();
    }
  }
}

async function startProxy(
  path: string,
  multiplex: BrowserMultiplex,
): Promise<() => Promise<void>> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const server = createServer();
  const connections = new Set<BrowserProxyConnection>();
  server.on('connection', (socket) => {
    if (connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    let connection: BrowserProxyConnection;
    connection = new BrowserProxyConnection(
      socket,
      multiplex,
      () => connections.delete(connection),
    );
    connections.add(connection);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return async () => {
    for (const connection of connections) connection.close();
    await closeServer(server);
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Materializes the fixed command shim and, for Desktop VM, an opaque local multiplex proxy. */
export async function prepareProviderSessionBrowserRuntime(input: {
  readonly encodedContext: string | undefined;
  readonly executableOwner?: number;
  readonly multiplex: BrowserMultiplex | null;
  readonly paths?: ProviderSessionBrowserRuntimePaths;
  readonly transport: string | undefined;
}): Promise<ProviderSessionBrowserRuntimeHandle | null> {
  if (input.encodedContext === undefined && input.transport === undefined) return null;
  if (input.encodedContext === undefined ||
      (input.transport !== 'unix-v1' && input.transport !== 'stdio-multiplex-v1')) {
    throw new Error('provider Browser runtime declaration is invalid');
  }
  const context = decodeProviderSessionBrowserContext(input.encodedContext);
  const paths = input.paths ?? DEFAULT_PATHS;
  validatePaths(paths);
  const owner = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (!Number.isSafeInteger(owner) || owner <= 0) {
    throw new Error('provider Browser runtime owner is invalid');
  }
  await privateDirectory(paths.root, owner);
  await privateDirectory(paths.bin, owner);
  await trustedExecutable(paths.node, input.executableOwner ?? 0);
  await trustedExecutable(paths.cli, input.executableOwner ?? 0);
  let closeProxy: (() => Promise<void>) | null = null;
  const endpoint = input.transport === 'unix-v1' ? paths.direct : paths.proxy;
  if (input.transport === 'unix-v1') await directSocket(paths.direct);
  else {
    if (!input.multiplex) throw new Error('provider Browser multiplex is unavailable');
    closeProxy = await startProxy(paths.proxy, input.multiplex);
  }
  try {
    await writeFile(paths.context, `${JSON.stringify({ ...context, endpoint })}\n`, {
      flag: 'wx', mode: 0o600,
    });
    await writeFile(paths.command, [
      '#!/bin/sh',
      `AGENT_DECK_BROWSER_CONTEXT_FILE='${paths.context}'`,
      'export AGENT_DECK_BROWSER_CONTEXT_FILE',
      `exec '${paths.node}' '${paths.cli}' "$@"`,
      '',
    ].join('\n'), { flag: 'wx', mode: 0o700 });
    return Object.freeze({
      environment: Object.freeze({
        PATH: `${paths.bin}:/opt/agent-deck/providers/grok:/usr/bin:/bin`,
      }),
      close: async () => { await closeProxy?.(); },
    });
  } catch (error) {
    await closeProxy?.().catch(() => undefined);
    throw error;
  }
}
