import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { CodexPipeBrowserFront, type BrowserUseNotifier } from './fronts/codex-pipe';
import {
  BrowserUseFrameDecoder,
  encodeBrowserUseFrame,
  isJsonRpcRequest,
  type JsonRpcId,
  type JsonRpcResponse,
} from './protocol';

export interface BrowserUseRequestHandler {
  handleRequest(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface BrowserUseServerOptions {
  createHandler?: (notifier: BrowserUseNotifier) => BrowserUseRequestHandler;
  onError?: (error: unknown) => void;
  pipePath?: string;
}

export interface BrowserUseServerHandle {
  pipePath: string;
  shutdown(): Promise<void>;
}

const UNIX_PIPE_ROOT = '/tmp/codex-browser-use';
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\codex-browser-use';

class BrowserUseConnection implements BrowserUseNotifier {
  private readonly decoder = new BrowserUseFrameDecoder();
  private readonly handler: BrowserUseRequestHandler;
  private closed = false;

  constructor(
    private readonly socket: Socket,
    createHandler: (notifier: BrowserUseNotifier) => BrowserUseRequestHandler,
    private readonly onError: (error: unknown) => void,
    private readonly onClosed: () => void,
  ) {
    this.handler = createHandler(this);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.onError(error));
    socket.on('close', () => {
      void this.close();
    });
  }

  notify(method: string, params: unknown): void {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClosed();
    try {
      await this.handler.dispose();
    } catch (error) {
      this.onError(error);
    }
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        if (!isJsonRpcRequest(message)) {
          throw new Error('Invalid browser-use JSON-RPC request.');
        }
        void this.dispatch(message.method, message.params, message.id);
      }
    } catch (error) {
      this.onError(error);
      void this.close();
    }
  }

  private async dispatch(
    method: string,
    params: unknown,
    id: JsonRpcId | undefined,
  ): Promise<void> {
    try {
      const result = await this.handler.handleRequest(method, params);
      if (id !== undefined) this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (id === undefined) {
        this.onError(error);
        return;
      }
      this.write({
        jsonrpc: '2.0',
        id,
        error: {
          code: 1,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private write(message: JsonRpcResponse | UnknownNotification): void {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeBrowserUseFrame(message));
    } catch (error) {
      this.onError(error);
      void this.close();
    }
  }
}

interface UnknownNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

export async function startBrowserUseServer(
  options: BrowserUseServerOptions = {},
): Promise<BrowserUseServerHandle> {
  const pipePath = options.pipePath ?? defaultBrowserUsePipePath();
  const onError = options.onError ?? (() => {});
  const createHandler =
    options.createHandler ?? ((notifier) => new CodexPipeBrowserFront(notifier));

  await preparePipePath(pipePath);
  const server = createServer();
  const connections = new Set<BrowserUseConnection>();
  server.on('connection', (socket) => {
    let connection: BrowserUseConnection;
    connection = new BrowserUseConnection(
      socket,
      createHandler,
      onError,
      () => connections.delete(connection),
    );
    connections.add(connection);
  });
  server.on('error', onError);
  await listen(server, pipePath);
  if (process.platform !== 'win32') await chmod(pipePath, 0o600);

  const cleanupAtExit = (): void => {
    if (process.platform === 'win32') return;
    try {
      unlinkSync(pipePath);
    } catch {
      // Orderly shutdown and crash cleanup race here; a missing path is already clean.
    }
  };
  process.once('exit', cleanupAtExit);

  let shutdownPromise: Promise<void> | null = null;
  return {
    pipePath,
    shutdown: async () => {
      shutdownPromise ??= (async () => {
        process.removeListener('exit', cleanupAtExit);
        const serverClosed = closeServer(server);
        await Promise.allSettled([...connections].map((connection) => connection.close()));
        await serverClosed;
        if (process.platform !== 'win32') {
          await unlink(pipePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      })();
      await shutdownPromise;
    },
  };
}

export function defaultBrowserUsePipePath(): string {
  return process.platform === 'win32'
    ? `${WINDOWS_PIPE_PREFIX}-agent-deck-${process.pid}`
    : join(UNIX_PIPE_ROOT, `agent-deck-${process.pid}`);
}

async function preparePipePath(pipePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const root = pipePath.slice(0, pipePath.lastIndexOf('/'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Browser-use pipe root is not a directory: ${root}`);
  }
  const getUid = process.getuid;
  if (typeof getUid === 'function' && rootStat.uid !== getUid.call(process)) {
    throw new Error(`Browser-use pipe root is owned by another user: ${root}`);
  }

  const active = await isPipeListening(pipePath);
  if (active) throw new Error(`Browser-use pipe is already active: ${pipePath}`);
  await unlink(pipePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function isPipeListening(pipePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath);
    let settled = false;
    const finish = (result: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error != null) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(false), 150);
    timer.unref();
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') finish(false);
      else finish(false, error);
    });
  });
}

async function listen(server: Server, pipePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipePath);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
