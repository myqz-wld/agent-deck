import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { BrowserUseFrameDecoder, encodeBrowserUseFrame } from './protocol';
import {
  browserOperationFailure,
  parseBrowserOperationRequest,
  type BrowserOperation,
  type BrowserOperationEnvelope,
} from './operation-contract';
import {
  BrowserLeaseResolutionError,
  type BrowserLeaseBinding,
  type BrowserLeaseRegistryCore,
} from './browser-lease-registry-core';
import {
  BROWSER_CLI_MAX_REQUEST_BYTES,
  BROWSER_CLI_MAX_RESPONSE_BYTES,
  parseBrowserCliWireEnvelope,
  safeBrowserCliOperation,
} from './browser-cli-broker-protocol';

const UNIX_ROOT = `/tmp/agent-deck-browser-cli-${process.getuid?.() ?? process.pid}`;
const WINDOWS_PREFIX = '\\\\.\\pipe\\agent-deck-browser-cli';
const MAX_CONNECTIONS = 64;
const CONNECTION_TIMEOUT_MS = 40_000;

export type BrowserCliBrokerExecutor = (
  binding: BrowserLeaseBinding,
  request: ReturnType<typeof parseBrowserOperationRequest>,
) => Promise<BrowserOperationEnvelope>;

export interface BrowserCliBrokerCoreOptions {
  readonly execute: BrowserCliBrokerExecutor;
  readonly pipePath?: string;
  readonly registry: BrowserLeaseRegistryCore;
  readonly onError?: (error: unknown) => void;
}

export interface BrowserCliBrokerHandle {
  readonly endpoint: string;
  shutdown(): Promise<void>;
}

function failure(
  operation: BrowserOperation,
  code: 'invalid_request' | 'browser_context_unavailable' | 'internal_error',
  message: string,
  retryable: boolean,
  nextAction: string,
): BrowserOperationEnvelope {
  return browserOperationFailure(operation, { code, message, retryable, nextAction });
}

async function executeWireRequest(
  value: unknown,
  registry: BrowserLeaseRegistryCore,
  execute: BrowserCliBrokerExecutor,
): Promise<BrowserOperationEnvelope> {
  const operation = safeBrowserCliOperation(
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { request?: unknown }).request
      : undefined,
  );
  let envelope: ReturnType<typeof parseBrowserCliWireEnvelope>;
  try {
    envelope = parseBrowserCliWireEnvelope(value);
  } catch {
    return failure(
      operation,
      'invalid_request',
      'Browser broker request was rejected.',
      false,
      'Run agent-deck-browser --help and fix the command syntax.',
    );
  }
  let binding: BrowserLeaseBinding;
  try {
    binding = registry.resolve(envelope.lease, envelope.proof);
  } catch (error) {
    if (!(error instanceof BrowserLeaseResolutionError)) throw error;
    return failure(
      operation,
      'browser_context_unavailable',
      'Browser context is unavailable for this runtime.',
      false,
      'Restart the interactive Agent Deck session with its Browser skill enabled.',
    );
  }
  let request: ReturnType<typeof parseBrowserOperationRequest>;
  try {
    request = parseBrowserOperationRequest(envelope.rawRequest);
  } catch {
    return failure(
      operation,
      'invalid_request',
      'Browser operation arguments were rejected.',
      false,
      'Run agent-deck-browser --help and fix the command syntax.',
    );
  }
  return execute(binding, request);
}

class BrowserCliBrokerConnection {
  private readonly decoder = new BrowserUseFrameDecoder({
    maxFrameBytes: BROWSER_CLI_MAX_REQUEST_BYTES,
    maxInputChunkBytes: BROWSER_CLI_MAX_REQUEST_BYTES + 4,
    maxMessagesPerInputChunk: 1,
    maxRetainedInputBytes: BROWSER_CLI_MAX_REQUEST_BYTES + 4,
    maxRetainedInputChunks: 128,
  });
  private accepted = false;
  private closed = false;
  private readonly timeout: NodeJS.Timeout;

  constructor(
    private readonly socket: Socket,
    private readonly registry: BrowserLeaseRegistryCore,
    private readonly execute: BrowserCliBrokerExecutor,
    private readonly onClosed: () => void,
    private readonly onError: (error: unknown) => void,
  ) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.once('error', (error) => this.fail(error));
    socket.once('close', () => this.close());
    this.timeout = setTimeout(
      () => this.fail(new Error('Browser broker connection timed out.')),
      CONNECTION_TIMEOUT_MS,
    );
    this.timeout.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timeout);
    this.decoder.clear();
    this.onClosed();
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    try {
      const messages = this.decoder.push(chunk);
      if (messages.length === 0) return;
      if (this.accepted || messages.length !== 1) throw new Error('Browser broker protocol error.');
      this.accepted = true;
      void this.dispatch(messages[0]);
    } catch (error) {
      this.fail(error);
    }
  }

  private async dispatch(value: unknown): Promise<void> {
    let response: BrowserOperationEnvelope;
    try {
      response = await executeWireRequest(value, this.registry, this.execute);
    } catch (error) {
      this.onError(error);
      response = failure(
        safeBrowserCliOperation(
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as { request?: unknown }).request
            : undefined,
        ),
        'internal_error',
        'Browser broker failed to complete the operation.',
        true,
        'Inspect the current tab state and retry once.',
      );
    }
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.end(encodeBrowserUseFrame(response, BROWSER_CLI_MAX_RESPONSE_BYTES));
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.onError(error);
    this.close();
  }
}

export async function startBrowserCliBrokerCore(
  options: BrowserCliBrokerCoreOptions,
): Promise<BrowserCliBrokerHandle> {
  const endpoint = options.pipePath ?? defaultBrowserCliBrokerPath();
  const onError = options.onError ?? (() => {});
  await preparePipe(endpoint);
  const server = createServer();
  const connections = new Set<BrowserCliBrokerConnection>();
  server.on('connection', (socket) => {
    if (connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    let connection: BrowserCliBrokerConnection;
    connection = new BrowserCliBrokerConnection(
      socket,
      options.registry,
      options.execute,
      () => connections.delete(connection),
      onError,
    );
    connections.add(connection);
  });
  await listen(server, endpoint);
  server.on('error', onError);
  if (process.platform !== 'win32') await chmod(endpoint, 0o600);
  let shutdownPromise: Promise<void> | null = null;
  return {
    endpoint,
    shutdown: () => {
      shutdownPromise ??= (async () => {
        for (const connection of connections) connection.close();
        await closeServer(server);
        options.registry.revokeAll();
        if (process.platform !== 'win32') {
          await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      })();
      return shutdownPromise;
    },
  };
}

export function defaultBrowserCliBrokerPath(): string {
  return process.platform === 'win32'
    ? `${WINDOWS_PREFIX}-${process.pid}`
    : join(UNIX_ROOT, `agent-deck-${process.pid}`);
}

async function preparePipe(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  const root = endpoint.slice(0, endpoint.lastIndexOf('/'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Browser CLI broker root is unavailable.');
  }
  if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) {
    throw new Error('Browser CLI broker root is unavailable.');
  }
  if (await isListening(endpoint)) throw new Error('Browser CLI broker is already active.');
  await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function isListening(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => finish(false), 150);
    timer.unref();
    let settled = false;
    const finish = (value: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') finish(false);
      else finish(false, error);
    });
  });
}

async function listen(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
