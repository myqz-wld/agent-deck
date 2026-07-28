import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';

import { CodexPipeBrowserFront, type BrowserUseNotifier } from './fronts/codex-pipe';
import {
  BrowserUseFrameDecoder,
  BrowserUseTransportLimitError,
  encodeBrowserUseFrame,
  isJsonRpcRequest,
  type JsonRpcId,
  type JsonRpcResponse,
} from './protocol';
import {
  resolveBrowserUseTransportLimits,
  type BrowserUseTransportLimits,
} from './transport-limits';

const logger = log.scope('browser-transport');

export interface BrowserUseRequestHandler {
  handleRequest(method: string, params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface BrowserUseServerOptions {
  createHandler?: (notifier: BrowserUseNotifier) => BrowserUseRequestHandler;
  limits?: Partial<BrowserUseTransportLimits>;
  onError?: (error: unknown) => void;
  pipePath?: string;
}

export interface BrowserUseServerHandle {
  pipePath: string;
  shutdown(): Promise<void>;
}

const UNIX_PIPE_ROOT = '/tmp/codex-browser-use';
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\codex-browser-use';
const REQUEST_FAILED_MESSAGE = 'Browser request failed.';
const RESOURCE_LIMIT_MESSAGE = 'Browser transport resource limit exceeded.';

type BrowserTransportReason =
  | BrowserUseTransportLimitError['reason']
  | 'dispose-error'
  | 'drain-timeout'
  | 'handler-error'
  | 'inflight-limit'
  | 'input-protocol-error'
  | 'invalid-request'
  | 'output-encoding-error'
  | 'output-queue-limit'
  | 'server-error'
  | 'socket-error'
  | 'socket-write-error';

export interface BrowserUseConnectionOptions {
  socket: Socket;
  createHandler: (notifier: BrowserUseNotifier) => BrowserUseRequestHandler;
  limits?: Partial<BrowserUseTransportLimits>;
  onError?: (error: unknown) => void;
  onClosed?: () => void;
}

export class BrowserUseConnection implements BrowserUseNotifier {
  private readonly socket: Socket;
  private readonly decoder: BrowserUseFrameDecoder;
  private readonly handler: BrowserUseRequestHandler;
  private readonly limits: BrowserUseTransportLimits;
  private readonly onError: (error: unknown) => void;
  private readonly onClosed: () => void;
  private readonly pendingOutput = new Map<number, Buffer>();
  private readonly reportedReasons = new Set<BrowserTransportReason>();
  private activeRequests = 0;
  private blockedOutputBytes = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private nextOutputId = 0;
  private nextOutputToFlush = 0;
  private pendingOutputBytes = 0;
  private writeBlocked = false;

  constructor(options: BrowserUseConnectionOptions) {
    this.socket = options.socket;
    this.onError = options.onError ?? (() => {});
    this.onClosed = options.onClosed ?? (() => {});
    this.limits = resolveBrowserUseTransportLimits(options.limits);
    this.decoder = new BrowserUseFrameDecoder({
      maxFrameBytes: this.limits.maxFrameBytes,
      maxInputChunkBytes: this.limits.maxInputChunkBytes,
      maxMessagesPerInputChunk: this.limits.maxMessagesPerInputChunk,
      maxRetainedInputBytes: this.limits.maxRetainedInputBytes,
      maxRetainedInputChunks: this.limits.maxRetainedInputChunks,
    });
    this.handler = options.createHandler(this);
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('drain', () => this.onDrain());
    this.socket.on('error', () => {
      this.report('closed', 'socket-error');
      void this.close();
    });
    this.socket.on('close', () => void this.close());
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    if (this.closePromise != null) return this.closePromise;
    this.closed = true;
    this.clearDrainTimer();
    this.decoder.clear();
    this.pendingOutput.clear();
    this.pendingOutputBytes = 0;
    this.blockedOutputBytes = 0;
    this.writeBlocked = false;
    this.closePromise = Promise.resolve()
      .then(() => this.handler.dispose())
      .catch(() => {
        this.report('closed', 'dispose-error');
      });
    this.onClosed();
    if (!this.socket.destroyed) this.socket.destroy();
    await this.closePromise;
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      const reason = error instanceof BrowserUseTransportLimitError
        ? error.reason
        : 'input-protocol-error';
      this.report('closed', reason);
      void this.close();
      return;
    }

    for (const message of messages) {
      if (!isJsonRpcRequest(message)) {
        this.report('closed', 'invalid-request');
        void this.close();
        return;
      }
      this.acceptRequest(message.method, message.params, message.id);
      if (this.closed) return;
    }
  }

  private acceptRequest(
    method: string,
    params: unknown,
    id: JsonRpcId | undefined,
  ): void {
    if (this.activeRequests >= this.limits.maxInflightRequests) {
      this.report(id === undefined ? 'closed' : 'rejected', 'inflight-limit');
      if (id === undefined) {
        void this.close();
      } else {
        this.write({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32001,
            message: RESOURCE_LIMIT_MESSAGE,
          },
        });
      }
      return;
    }
    this.activeRequests += 1;
    void this.dispatch(method, params, id).finally(() => {
      this.activeRequests -= 1;
    });
  }

  private async dispatch(
    method: string,
    params: unknown,
    id: JsonRpcId | undefined,
  ): Promise<void> {
    try {
      const result = await this.handler.handleRequest(method, params);
      if (id !== undefined) this.write({ jsonrpc: '2.0', id, result });
    } catch {
      this.report('rejected', 'handler-error');
      if (id === undefined) return;
      this.write({
        jsonrpc: '2.0',
        id,
        error: {
          code: 1,
          message: REQUEST_FAILED_MESSAGE,
        },
      });
    }
  }

  private write(message: JsonRpcResponse | UnknownNotification): void {
    if (this.closed || this.socket.destroyed) return;
    let frame: Buffer;
    try {
      frame = encodeBrowserUseFrame(message, this.limits.maxOutputFrameBytes);
    } catch (error) {
      const reason = error instanceof BrowserUseTransportLimitError
        ? error.reason
        : 'output-encoding-error';
      this.report('closed', reason);
      void this.close();
      return;
    }

    if (this.writeBlocked) {
      if (this.totalQueuedOutputBytes() + frame.byteLength > this.limits.maxQueuedOutputBytes) {
        this.report('closed', 'output-queue-limit');
        void this.close();
        return;
      }
      this.pendingOutput.set(this.nextOutputId++, frame);
      this.pendingOutputBytes += frame.byteLength;
      return;
    }
    this.writeFrame(frame);
  }

  private writeFrame(frame: Buffer): void {
    if (
      frame.byteLength > this.limits.maxQueuedOutputBytes
      || this.socket.writableLength + frame.byteLength > this.limits.maxQueuedOutputBytes
    ) {
      this.report('closed', 'output-queue-limit');
      void this.close();
      return;
    }
    try {
      const accepted = this.socket.write(frame);
      if (this.socket.writableLength > this.limits.maxQueuedOutputBytes) {
        this.report('closed', 'output-queue-limit');
        void this.close();
        return;
      }
      if (!accepted) {
        this.writeBlocked = true;
        this.blockedOutputBytes = Math.max(this.socket.writableLength, frame.byteLength);
        this.startDrainTimer();
      }
    } catch {
      this.report('closed', 'socket-write-error');
      void this.close();
    }
  }

  private onDrain(): void {
    if (this.closed || !this.writeBlocked) return;
    this.clearDrainTimer();
    this.writeBlocked = false;
    this.blockedOutputBytes = 0;
    while (!this.closed && !this.writeBlocked && this.pendingOutput.size > 0) {
      const frame = this.pendingOutput.get(this.nextOutputToFlush);
      if (frame == null) break;
      this.pendingOutput.delete(this.nextOutputToFlush++);
      this.pendingOutputBytes -= frame.byteLength;
      this.writeFrame(frame);
    }
    if (this.pendingOutput.size === 0) {
      this.nextOutputId = 0;
      this.nextOutputToFlush = 0;
    }
  }

  private startDrainTimer(): void {
    this.clearDrainTimer();
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.closed || !this.writeBlocked) return;
      this.report('closed', 'drain-timeout');
      void this.close();
    }, this.limits.drainTimeoutMs);
    this.drainTimer.unref();
  }

  private clearDrainTimer(): void {
    if (this.drainTimer == null) return;
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private totalQueuedOutputBytes(): number {
    return this.blockedOutputBytes + this.pendingOutputBytes;
  }

  private report(outcome: 'closed' | 'rejected', reason: BrowserTransportReason): void {
    if (this.reportedReasons.has(reason)) return;
    this.reportedReasons.add(reason);
    const diagnostic = safeDiagnostic({
      event: 'browser-transport',
      runId: getProcessRunId(),
      outcome,
      reason,
      activeRequests: this.activeRequests,
      retainedInputBytes: this.decoder.retainedBytes,
      queuedOutputBytes: this.totalQueuedOutputBytes(),
    });
    logger.warn('connection state changed', diagnostic);
    try {
      this.onError(diagnostic);
    } catch {
      // Diagnostics must never change transport state.
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
  const createHandler = options.createHandler
    ?? ((notifier) => new CodexPipeBrowserFront(notifier));
  let serverFailureReported = false;
  const reportServerFailure = (): void => {
    if (serverFailureReported) return;
    serverFailureReported = true;
    reportServerError(onError);
  };

  try {
    await preparePipePath(pipePath);
  } catch {
    reportServerFailure();
    throw new Error('Browser server failed to start.');
  }
  const server = createServer();
  const connections = new Set<BrowserUseConnection>();
  server.on('connection', (socket) => {
    let connection: BrowserUseConnection;
    try {
      connection = new BrowserUseConnection({
        socket,
        createHandler,
        limits: options.limits,
        onError,
        onClosed: () => connections.delete(connection),
      });
    } catch {
      reportServerError(onError);
      socket.destroy();
      return;
    }
    connections.add(connection);
  });
  server.on('error', reportServerFailure);
  try {
    await listen(server, pipePath);
    if (process.platform !== 'win32') await chmod(pipePath, 0o600);
  } catch {
    reportServerFailure();
    const serverClosed = closeServer(server);
    await Promise.allSettled([...connections].map((connection) => connection.close()));
    await serverClosed;
    throw new Error('Browser server failed to start.');
  }
  server.removeListener('error', reportServerFailure);
  server.on('error', () => reportServerError(onError));

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
      try {
        await shutdownPromise;
      } catch {
        throw new Error('Browser server failed to stop.');
      }
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
    throw new Error('Browser server pipe root is unavailable.');
  }
  const getUid = process.getuid;
  if (typeof getUid === 'function' && rootStat.uid !== getUid.call(process)) {
    throw new Error('Browser server pipe root is unavailable.');
  }

  const active = await isPipeListening(pipePath);
  if (active) throw new Error('Browser server is already active.');
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

function reportServerError(onError: (error: unknown) => void): void {
  const diagnostic = safeDiagnostic({
    event: 'browser-transport',
    runId: getProcessRunId(),
    outcome: 'closed',
    reason: 'server-error',
  });
  logger.warn('server state changed', diagnostic);
  try {
    onError(diagnostic);
  } catch {
    // Diagnostics must never change server state.
  }
}
